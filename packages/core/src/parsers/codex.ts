import { contentWordCount, embed } from '../embed.js';
import { projectFromCwd } from '../names.js';
import { estimateTokens } from '../estimate.js';
import { contextWindowInfo } from '../models.js';
import { redact } from '../redact.js';
import type { ToolCall, TurnEvent } from '../types.js';
import { hash, ulid } from '../util.js';
import { splitBlocks } from './blocks.js';

// RF-CAP-03 / CP-033: parser incremental de rollouts de Codex CLI
// (~/.codex/sessions/YYYY/MM/DD/rollout-<fecha>-<uuid>.jsonl).
//
// Formato actual (codex-rs, cli ≥ 0.2x): cada línea es {timestamp, type, payload} con
//   - session_meta   → payload {id, timestamp, cwd, originator, cli_version, ...}
//   - turn_context   → payload {model, cwd, approval_policy, effort, ...}
//   - event_msg      → payload.type: user_message {message}, token_count {info, rate_limits},
//                      agent_message, agent_reasoning, ...
//   - response_item  → payload.type: message, reasoning, function_call {name, arguments, call_id},
//                      function_call_output {call_id, output}, custom_tool_call(_output),
//                      local_shell_call, web_search_call, ...
//   - compacted      → resumen tras /compact.
// Formato legado (2025 temprano): primera línea {id, timestamp, instructions, git} y luego ítems
// de respuesta sueltos ({type:'message', ...}, {record_type:'state'}); no trae uso de tokens.
//
// Granularidad (DECISIONS): un TurnEvent por token_count con info (una llamada a la API);
// turn = índice del user_message. Los resultados de herramientas se adjuntan al siguiente
// token_count (la llamada que los consumió), igual que en Claude Code.
// Uso: input = input_tokens − cached_input_tokens (types.ts TokenUsage), cacheRead = cached,
// output = output_tokens (incluye razonamiento), reasoning = reasoning_output_tokens.

export interface CodexParserOptions {
  /** Id de sesión (API.md: id del archivo de sesión). Si falta, se usa session_meta.id. */
  sessionId?: string;
  embedPrompts?: boolean;
}

interface PendingTool {
  name: string;
  argsHash: string;
}

const MAX_PENDING_TOOLS = 500;

/** Extrae el uuid de sesión de `rollout-2025-09-10T12-00-00-<uuid>.jsonl`. */
export function codexSessionIdFromPath(path: string): string | undefined {
  const m = /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return m?.[1];
}

export class CodexParser {
  readonly formatVersions = new Set<string>();
  errors = 0;
  /** Registros con forma desconocida (ignorados). */
  unknown = 0;
  sessionId?: string;
  private client = 'codex';
  /** CP-061: nombre base de `session_meta.cwd` / `turn_context.cwd`. */
  project?: string;
  private model = '';
  private turn = 0;
  private toolUses = new Map<string, PendingTool>();
  private pendingResults: ToolCall[] = [];
  private lastAssistantTs?: number;
  private promptTs?: number;
  private lastTotal = -1;
  private legacy = false;

  constructor(private opts: CodexParserOptions = {}) {
    this.sessionId = opts.sessionId;
  }

  /** Procesa una línea JSONL; devuelve 0..n eventos. Nunca lanza. */
  feed(line: string): TurnEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      this.errors++;
      return [];
    }
    if (!rec || typeof rec !== 'object') {
      this.unknown++;
      return [];
    }
    try {
      return this.onRecord(rec);
    } catch {
      this.errors++;
      return [];
    }
  }

  private onRecord(rec: any): TurnEvent[] {
    const ts = Date.parse(rec.timestamp ?? '') || Date.now();
    if (typeof rec.type === 'string' && rec.payload && typeof rec.payload === 'object') {
      const p = rec.payload;
      switch (rec.type) {
        case 'session_meta':
          this.onMeta(p.meta ?? p);
          return [];
        case 'turn_context':
          if (typeof p.model === 'string') this.model = p.model;
          if (projectFromCwd(p.cwd)) this.project = projectFromCwd(p.cwd);
          return [];
        case 'event_msg':
          return this.onEventMsg(p, ts);
        case 'response_item':
          this.onResponseItem(p);
          return [];
        case 'compacted':
          return [];
        default:
          this.unknown++;
          return [];
      }
    }
    // Formato legado: cabecera y luego ítems sueltos.
    if (rec.record_type) return [];
    if (!this.legacy && typeof rec.id === 'string' && ('instructions' in rec || 'git' in rec)) {
      this.legacy = true;
      this.formatVersions.add('legacy');
      this.onMeta(rec);
      return [];
    }
    if (typeof rec.type === 'string') {
      if (rec.type === 'message' && rec.role === 'user') {
        this.legacy = true;
        const text = legacyUserText(rec.content);
        return text ? this.onPrompt(text, ts) : [];
      }
      this.onResponseItem(rec);
      return [];
    }
    this.unknown++;
    return [];
  }

  private onMeta(m: any): void {
    if (!this.sessionId && typeof m.id === 'string') this.sessionId = m.id;
    if (typeof m.originator === 'string') this.client = m.originator;
    if (m.cli_version) this.formatVersions.add(String(m.cli_version));
    if (typeof m.model === 'string' && !this.model) this.model = m.model;
    // CP-061: nombre base de la carpeta de trabajo.
    const project = projectFromCwd(m.cwd);
    if (project) this.project = project;
  }

  /** CP-061: metadatos legibles (Codex no tiene título de conversación). */
  meta(): { project?: string; title?: string } {
    return { project: this.project };
  }

  private onEventMsg(p: any, ts: number): TurnEvent[] {
    switch (p.type) {
      case 'user_message': {
        const text = typeof p.message === 'string' ? p.message : '';
        return text.trim() ? this.onPrompt(text, ts) : [];
      }
      case 'token_count':
        return this.onTokenCount(p, ts);
      default:
        return [];
    }
  }

  private onResponseItem(p: any): void {
    switch (p.type) {
      case 'function_call':
      case 'custom_tool_call': {
        const id = p.call_id ?? p.id;
        if (typeof id !== 'string') return;
        const args = p.type === 'function_call' ? parseArgs(p.arguments) : p.input;
        this.remember(id, { name: String(p.name ?? 'unknown'), argsHash: hash(JSON.stringify(args ?? {})) });
        return;
      }
      case 'local_shell_call': {
        const id = p.call_id ?? p.id;
        if (typeof id === 'string') this.remember(id, { name: 'local_shell', argsHash: hash(JSON.stringify(p.action ?? {})) });
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const tu = this.toolUses.get(p.call_id);
        const { text, failed } = parseToolOutput(p.output);
        this.pendingResults.push({
          name: tu?.name ?? 'unknown',
          argsHash: tu?.argsHash ?? '',
          failed,
          resultTokens: estimateTokens(text, 'openai'),
        });
        return;
      }
      default:
        return;
    }
  }

  private remember(id: string, t: PendingTool): void {
    this.toolUses.set(id, t);
    if (this.toolUses.size > MAX_PENDING_TOOLS) {
      const first = this.toolUses.keys().next().value;
      if (first !== undefined) this.toolUses.delete(first);
    }
  }

  private onPrompt(text: string, ts: number): TurnEvent[] {
    this.promptTs = ts;
    this.turn += 1;
    const win = contextWindowInfo(this.model, 'openai');
    const ev: TurnEvent = {
      id: ulid(ts),
      source: 'codex',
      provider: 'openai',
      client: this.client,
      sessionId: this.sessionId ?? 'unknown',
      turn: this.turn,
      ts: new Date(ts).toISOString(),
      model: this.model,
      tokens: { input: 0, output: 0, estimated: false },
      contextSize: 0,
      contextWindow: win.window,
      windowSource: win.source,
      idleSincePrevMs: this.lastAssistantTs ? Math.max(0, ts - this.lastAssistantTs) : 0,
      promptHash: hash(text),
      promptTokens: estimateTokens(text, 'openai'),
      promptContentWords: contentWordCount(redact(text)),
      phase: 'prompt',
      blocks: splitBlocks(text),
      ...(this.project ? { project: this.project } : {}),
    };
    if (this.opts.embedPrompts !== false) ev.promptEmbedding = embed(redact(text));
    return [ev];
  }

  private onTokenCount(p: any, ts: number): TurnEvent[] {
    const info = p.info;
    const last = info?.last_token_usage;
    if (!last || typeof last !== 'object') return []; // token_count con info null: sólo rate limits
    // Codex a veces repite token_count sin llamada nueva: se deduplica por el total acumulado.
    const total = Number(info.total_token_usage?.total_tokens ?? NaN);
    if (Number.isFinite(total)) {
      if (total === this.lastTotal) return [];
      this.lastTotal = total;
    }
    const inputAll = num(last.input_tokens);
    const cached = Math.min(num(last.cached_input_tokens), inputAll);
    const output = num(last.output_tokens);
    const reasoning = num(last.reasoning_output_tokens);
    if (this.turn === 0) this.turn = 1;
    const ctx = inputAll + output;
    const win = contextWindowInfo(this.model, 'openai', {
      reported: num(info.model_context_window) || undefined,
      observedContext: ctx,
    });
    const idle =
      this.promptTs !== undefined
        ? Math.max(0, this.promptTs - (this.lastAssistantTs ?? this.promptTs))
        : this.lastAssistantTs
          ? Math.max(0, ts - this.lastAssistantTs)
          : 0;
    this.promptTs = undefined;
    this.lastAssistantTs = ts;
    const toolCalls = this.pendingResults;
    this.pendingResults = [];
    return [
      {
        id: ulid(ts),
        source: 'codex',
        provider: 'openai',
        client: this.client,
        sessionId: this.sessionId ?? 'unknown',
        turn: this.turn,
        ts: new Date(ts).toISOString(),
        model: this.model,
        tokens: {
          input: inputAll - cached,
          output,
          cacheRead: cached,
          reasoning: reasoning || undefined,
          estimated: false,
        },
        contextSize: ctx,
        contextWindow: win.window,
        windowSource: win.source,
        idleSincePrevMs: idle,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        promptHash: '',
        phase: 'response',
        ...(this.project ? { project: this.project } : {}),
      },
    ];
  }
}

function num(x: unknown): number {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function parseArgs(a: unknown): unknown {
  if (typeof a !== 'string') return a;
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
}

/** Texto de usuario en formato legado, ignorando instrucciones y contexto de entorno inyectados. */
function legacyUserText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  const text = content
    .map((b: any) => (b?.type === 'input_text' || b?.type === 'text' ? String(b.text ?? '') : ''))
    .join('\n')
    .trim();
  if (/^<(user_instructions|environment_context)>/.test(text)) return '';
  return text;
}

/**
 * Salida de herramienta de Codex. Variantes conocidas:
 * - string JSON {"output": "...", "metadata": {"exit_code": 1, ...}} (shell, versiones 0.2x–0.3x)
 * - string de texto "Exit code: 1\nWall time: ...\nOutput:\n..." (versiones nuevas)
 * - objeto {content, success} (FunctionCallOutputPayload serializado como objeto)
 */
export function parseToolOutput(out: unknown): { text: string; failed: boolean } {
  if (out && typeof out === 'object') {
    const o = out as any;
    const text = typeof o.content === 'string' ? o.content : JSON.stringify(o);
    return { text, failed: o.success === false || (typeof o.exit_code === 'number' && o.exit_code !== 0) };
  }
  if (typeof out !== 'string') return { text: '', failed: false };
  const trimmed = out.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const o = JSON.parse(trimmed);
      const code = o?.metadata?.exit_code ?? o?.exit_code;
      const text = typeof o?.output === 'string' ? o.output : out;
      return { text, failed: (typeof code === 'number' && code !== 0) || o?.success === false };
    } catch {
      /* texto que empieza con llave: se trata como texto */
    }
  }
  const m = /^Exit code:\s*(-?\d+)/m.exec(out);
  if (m) return { text: out, failed: Number(m[1]) !== 0 };
  return { text: out, failed: /^(error|failed|aborted)\b/i.test(trimmed) };
}
