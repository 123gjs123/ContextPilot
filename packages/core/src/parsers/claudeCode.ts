import { contentWordCount, embed } from '../embed.js';
import { cleanTitle, projectFromCwd } from '../names.js';
import { estimateTokens } from '../estimate.js';
import { contextWindowFor, contextWindowInfo } from '../models.js';
import { redact } from '../redact.js';
import type { AvailableTool, ToolCall, TurnEvent } from '../types.js';
import { hash, ulid } from '../util.js';
import { splitBlocks } from './blocks.js';

// RF-CAP-01: parser incremental de transcripts JSONL de Claude Code.
// - Un mensaje de API aparece en varias líneas (un bloque de contenido por línea) con el mismo
//   message.id y el mismo usage: se emite UN evento por message.id.
// - Resultados de herramientas llegan en el registro 'user' siguiente; se adjuntan al próximo
//   evento de respuesta (la llamada de API que los consumió).
// - Registros de subagentes (isSidechain, o archivos <sesión>/subagents/*.jsonl con opción
//   sidechain) se emiten con sidechain=true y sessionId del padre: suman a acumulados y a R5/R8
//   pero no cuentan para el contexto de la sesión principal (DECISIONS «subagentes»).
// - D-4 (R6): inventario de servidores MCP desde los adjuntos del transcript (deferred_tools_delta,
//   deferred_tools_record, mcp_instructions_delta). Costo por turno ESTIMADO (nombres listados +
//   instrucciones + definiciones cargadas), agrupado por servidor `mcp__<servidor>`.
// - D-2 (R1): archivos y herramientas de los últimos 5 prompts, sólo en memoria, para el foco de
//   `/compact <foco>`. Nunca se emite en eventos ni se persiste.

/**
 * D-16 / CP-027.3: versiones de Claude Code cuyo formato de transcript se conoce (mayor 1 y 2; en
 * los transcripts reales de la aceptación: 2.1.179 … 2.1.285). Fuera de este rango el parser no
 * emite cifras y el adaptador pasa a `error`.
 */
export const CLAUDE_CODE_KNOWN_MAJORS: readonly number[] = [1, 2];

/** D-16: la versión del registro es conocida (`<mayor>.<menor>.<parche>` con mayor en rango). */
export function isKnownClaudeCodeVersion(v: string): boolean {
  const m = /^(\d+)\.\d+\.\d+/.exec(v);
  return !!m && CLAUDE_CODE_KNOWN_MAJORS.includes(Number(m[1]));
}

/** Herramientas que no dicen nada del foco del trabajo. */
const FOCUS_IGNORED_TOOLS = new Set(['TodoWrite', 'ToolSearch', 'TaskOutput', 'TaskStop', 'SubagentHandback']);
const FOCUS_TURNS = 5;
const FOCUS_MAX_CHARS = 180;

interface TurnActivity {
  files: Map<string, number>;
  tools: Map<string, number>;
}

/** Nombre de servidor MCP normalizado como en los nombres de herramienta (`claude.ai X` → `claude_ai_X`). */
export function mcpServerKey(displayOrTool: string): string {
  if (displayOrTool.startsWith('mcp__')) return displayOrTool.split('__')[1] ?? displayOrTool;
  return displayOrTool.replace(/[^A-Za-z0-9_-]/g, '_');
}

interface PendingTool {
  name: string;
  argsHash: string;
}

export interface ClaudeCodeParserOptions {
  embedPrompts?: boolean;
  /** Sesión padre a la que se atribuyen los eventos de subagente (default: sessionId del registro). */
  parentSessionId?: string;
  /** true = todo el archivo es de un subagente (subagents/*.jsonl): cada línea se trata como sidechain. */
  sidechain?: boolean;
}

export class ClaudeCodeParser {
  readonly formatVersions = new Set<string>();
  private seen = new Set<string>();
  private toolUses = new Map<string, PendingTool>();
  private pendingResults: ToolCall[] = [];
  /** Resultados de herramientas de subagentes, separados de los del hilo principal. */
  private pendingSideResults: ToolCall[] = [];
  private turn = 0;
  private lastAssistantTs?: number;
  private promptTs?: number;
  private cacheTtlMs?: number;
  private lastModel = '';
  /** Ventana inferida: si el contexto observado supera la nominal, el modelo corre con 1M. */
  private windowFloor = 0;
  sessionId?: string;
  errors = 0;
  /**
   * D-16 / CP-027.3 / CP-030.5: registros descartados por formato desconocido (versión fuera de rango
   * o llamada sin `message.usage` con `input_tokens`/`output_tokens` numéricos). No emiten cifras.
   */
  formatErrors = 0;
  /** D-16: detalle del último problema de formato (para health). */
  formatIssue?: string;
  /** D-4: nombre de herramienta diferida → tokens estimados de su línea en el listado. */
  private deferred = new Map<string, number>();
  /** D-4: definiciones completas cargadas (ToolSearch) → tokens estimados. */
  private loadedDefs = new Map<string, number>();
  /** D-4: servidor MCP → tokens estimados de sus instrucciones. */
  private mcpInstructions = new Map<string, number>();
  private inventoryDirty = false;
  private inventory: AvailableTool[] = [];
  /** D-2: actividad de los últimos prompts (sólo memoria). */
  private activity: TurnActivity[] = [];
  /** CP-061: carpeta de trabajo (nombre base del `cwd` de los registros) y último `ai-title`. */
  project?: string;
  /** R6/R11: ruta completa del `cwd` (para desactivar MCP por proyecto). Sólo memoria. */
  cwd?: string;
  /** CP-061: título de la conversación (registro `ai-title`). Contenido del usuario: sólo memoria. */
  title?: string;

  constructor(private opts: ClaudeCodeParserOptions = {}) {}

  /** D-4: servidores MCP disponibles con costo por turno estimado. */
  toolsAvailable(): AvailableTool[] {
    if (!this.inventoryDirty) return this.inventory;
    this.inventoryDirty = false;
    const by = new Map<string, number>();
    const add = (server: string, t: number) => by.set(server, (by.get(server) ?? 0) + t);
    for (const [name, t] of this.deferred) if (name.startsWith('mcp__')) add(mcpServerKey(name), t);
    for (const [name, t] of this.loadedDefs) if (name.startsWith('mcp__')) add(mcpServerKey(name), t);
    for (const [server, t] of this.mcpInstructions) add(server, t);
    this.inventory = [...by].map(([server, t]) => ({ name: `mcp__${server}`, definitionTokens: Math.round(t), estimated: true }));
    return this.inventory;
  }

  /** CP-061: metadatos legibles de la sesión (en memoria). */
  meta(): { project?: string; title?: string; cwd?: string } {
    return { project: this.project, title: this.title, cwd: this.cwd };
  }

  /**
   * D-2 / CP-010.3: foco para `/compact` con los archivos y herramientas más usados en los últimos 5
   * prompts (sin contenido de prompt). undefined si no hay actividad.
   */
  focus(): string | undefined {
    const files = new Map<string, number>();
    const tools = new Map<string, number>();
    for (const a of this.activity) {
      for (const [k, v] of a.files) files.set(k, (files.get(k) ?? 0) + v);
      for (const [k, v] of a.tools) tools.set(k, (tools.get(k) ?? 0) + v);
    }
    const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
    const f = top(files, 4);
    const t = top(tools, 3);
    if (!f.length && !t.length) return undefined;
    let text = f.length ? `Conservá el trabajo sobre ${f.join(', ')}` : 'Conservá el trabajo reciente';
    if (t.length) text += ` (${t.join(', ')})`;
    text += '; resumí el resto.';
    text = redact(text);
    return text.length > FOCUS_MAX_CHARS ? `${text.slice(0, FOCUS_MAX_CHARS - 1)}…` : text;
  }

  private onAttachment(a: any): void {
    if (!a || typeof a !== 'object') return;
    if (a.type === 'deferred_tools_delta') {
      const names: unknown[] = [...(Array.isArray(a.addedNames) ? a.addedNames : []), ...(Array.isArray(a.readdedNames) ? a.readdedNames : [])];
      const lines: unknown[] = Array.isArray(a.addedLines) ? a.addedLines : [];
      names.forEach((n, i) => {
        if (typeof n !== 'string') return;
        const line = typeof lines[i] === 'string' ? (lines[i] as string) : n;
        this.deferred.set(n, estimateTokens(line) + 1);
      });
      for (const n of Array.isArray(a.removedNames) ? a.removedNames : []) {
        this.deferred.delete(n);
        this.loadedDefs.delete(n);
      }
      this.inventoryDirty = true;
    } else if (a.type === 'deferred_tools_record') {
      for (const e of Array.isArray(a.entries) ? a.entries : []) {
        if (typeof e?.name === 'string') this.loadedDefs.set(e.name, estimateTokens(JSON.stringify(e)));
      }
      this.inventoryDirty = true;
    } else if (a.type === 'mcp_instructions_delta') {
      const names: unknown[] = Array.isArray(a.addedNames) ? a.addedNames : [];
      const blocks: unknown[] = Array.isArray(a.addedBlocks) ? a.addedBlocks : [];
      names.forEach((n, i) => {
        if (typeof n === 'string') this.mcpInstructions.set(mcpServerKey(n), estimateTokens(String(blocks[i] ?? '')));
      });
      for (const n of Array.isArray(a.removedNames) ? a.removedNames : []) if (typeof n === 'string') this.mcpInstructions.delete(mcpServerKey(n));
      this.inventoryDirty = true;
    }
  }

  /** D-2: registra archivos (sólo el nombre base) y herramientas del hilo principal en el prompt actual. */
  private noteActivity(msg: any): void {
    const cur = this.activity.at(-1);
    if (!cur) return;
    for (const block of msg.content ?? []) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
      if (!FOCUS_IGNORED_TOOLS.has(block.name)) cur.tools.set(block.name, (cur.tools.get(block.name) ?? 0) + 1);
      const inp = block.input ?? {};
      const path = inp.file_path ?? inp.notebook_path ?? (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write' ? inp.path : undefined);
      if (typeof path === 'string' && path) {
        const base = path.split(/[\\/]/).pop()!;
        if (base) cur.files.set(base, (cur.files.get(base) ?? 0) + 1);
      }
    }
  }

  /** Procesa una línea JSONL; devuelve 0..n eventos. Líneas inválidas se cuentan y se ignoran. */
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
    if (rec.version) {
      const v = String(rec.version);
      this.formatVersions.add(v);
      if (!isKnownClaudeCodeVersion(v)) {
        // D-16: formato no verificado: se descarta el registro entero (nunca cifras parciales).
        return this.formatError(`versión de formato desconocida: ${v.slice(0, 32)} (conocidas: ${CLAUDE_CODE_KNOWN_MAJORS.join('.x, ')}.x)`);
      }
    }
    if (rec.sessionId) this.sessionId = rec.sessionId;
    // CP-061: nombre de la carpeta de trabajo y título que Claude Code genera para la conversación.
    // El cwd de un subagente es el del proyecto: también sirve (así la sesión tiene nombre aunque el
    // replay lea primero los archivos de subagentes). El título sólo sale del hilo principal.
    const project = projectFromCwd(rec.cwd);
    if (project) this.project = project;
    // Carpeta donde arrancó la sesión (la que Claude Code usa para .claude/settings.local.json),
    // no la actual: el agente puede hacer `cd` a una subcarpeta.
    if (!this.cwd && typeof rec.cwd === 'string' && rec.cwd) this.cwd = rec.cwd;
    if (!rec.isSidechain && !this.opts.sidechain) {
      if (rec.type === 'ai-title') {
        const title = cleanTitle(rec.aiTitle);
        if (title) this.title = title;
        return [];
      }
    }
    if (rec.type === 'assistant' && rec.message && rec.message.model !== '<synthetic>' && !validUsage(rec.message)) {
      return this.formatError('llamada sin message.id o message.usage con input_tokens/output_tokens numéricos');
    }
    if (rec.type === 'attachment' && !rec.isSidechain && !this.opts.sidechain) {
      this.onAttachment(rec.attachment);
      return [];
    }
    if (rec.isSidechain || this.opts.sidechain) return this.onSidechain(rec);
    if (rec.type === 'user') return this.onUser(rec);
    if (rec.type === 'assistant') return this.onAssistant(rec);
    return [];
  }

  /** CP-061: project/title para el evento (sólo los que se conocen). */
  private names(): Pick<TurnEvent, 'project' | 'title'> {
    return { ...(this.project ? { project: this.project } : {}), ...(this.title ? { title: this.title } : {}) };
  }

  private formatError(detail: string): TurnEvent[] {
    this.formatErrors++;
    this.formatIssue = detail;
    return [];
  }

  private onUser(rec: any): TurnEvent[] {
    const content = rec.message?.content;
    const ts = Date.parse(rec.timestamp ?? '') || Date.now();
    if (this.collectToolResults(content, this.pendingResults)) return [];
    return this.onPrompt(rec, content, ts);
  }

  private collectToolResults(content: unknown, into: ToolCall[]): boolean {
    if (!Array.isArray(content)) return false;
    let had = false;
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      had = true;
      const tu = this.toolUses.get(block.tool_use_id);
      into.push({
        name: tu?.name ?? 'unknown',
        argsHash: tu?.argsHash ?? '',
        failed: block.is_error === true,
        resultTokens: estimateTokens(textOf(block.content)),
      });
    }
    return had;
  }

  /** Línea de subagente: sólo interesan resultados de herramientas y llamadas con usage. */
  private onSidechain(rec: any): TurnEvent[] {
    if (rec.type === 'user') {
      this.collectToolResults(rec.message?.content, this.pendingSideResults);
      return [];
    }
    if (rec.type !== 'assistant' || !rec.message) return [];
    const msg = rec.message;
    this.rememberToolUses(msg);
    const usage = msg.usage;
    const id: string | undefined = msg.id;
    if (!id || !usage || this.seen.has(id) || msg.model === '<synthetic>') return [];
    this.seen.add(id);
    const ts = Date.parse(rec.timestamp ?? '') || Date.now();
    const model: string = msg.model ?? '';
    const input = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const toolCalls = this.pendingSideResults;
    this.pendingSideResults = [];
    const win = contextWindowInfo(model, 'anthropic', { observedContext: input + cacheRead + cacheWrite + output });
    return [
      {
        id: ulid(ts),
        source: 'claude-code',
        provider: 'anthropic',
        client: rec.entrypoint ?? 'claude-code',
        sessionId: this.opts.parentSessionId ?? rec.sessionId ?? this.sessionId ?? 'unknown',
        turn: this.turn,
        ts: new Date(ts).toISOString(),
        model,
        tokens: {
          input,
          output,
          cacheRead,
          cacheWrite,
          reasoning: usage.output_tokens_details?.thinking_tokens || undefined,
          estimated: false,
        },
        // Contexto propio del subagente (informativo): applyEvent no lo usa si sidechain=true.
        contextSize: input + cacheRead + cacheWrite + output,
        contextWindow: win.window,
        windowSource: win.source,
        idleSincePrevMs: 0,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        promptHash: '',
        phase: 'response',
        sidechain: true,
        ...(this.project ? { project: this.project } : {}),
      },
    ];
  }

  private rememberToolUses(msg: any): void {
    for (const block of msg.content ?? []) {
      if (block?.type === 'tool_use') {
        this.toolUses.set(block.id, { name: block.name, argsHash: hash(JSON.stringify(block.input ?? {})) });
      }
    }
  }

  /** Ventana + origen: 'observed' cuando el contexto ya superó la nominal (1M inferido). */
  private windowOf(model: string): { contextWindow: number; windowSource: TurnEvent['windowSource'] } {
    const info = contextWindowInfo(model, 'anthropic');
    if (this.windowFloor > info.window) return { contextWindow: this.windowFloor, windowSource: 'observed' };
    return { contextWindow: info.window, windowSource: info.source };
  }

  private onPrompt(rec: any, content: unknown, ts: number): TurnEvent[] {
    if (rec.isMeta || rec.isCompactSummary) return [];
    const text = textOf(content);
    if (!text || text.startsWith('<command-') || text.startsWith('<local-command')) return [];
    this.promptTs = ts;
    this.turn += 1;
    this.activity.push({ files: new Map(), tools: new Map() });
    if (this.activity.length > FOCUS_TURNS) this.activity.shift();
    const clean = redact(text);
    const promptTokens = estimateTokens(text);
    const ev: TurnEvent = {
      id: ulid(ts),
      source: 'claude-code',
      provider: 'anthropic',
      client: rec.entrypoint ?? 'claude-code',
      sessionId: rec.sessionId ?? this.sessionId ?? 'unknown',
      turn: this.turn,
      ts: new Date(ts).toISOString(),
      model: this.lastModel,
      tokens: { input: 0, output: 0, estimated: false },
      contextSize: 0,
      ...this.windowOf(this.lastModel),
      idleSincePrevMs: this.lastAssistantTs ? Math.max(0, ts - this.lastAssistantTs) : 0,
      promptHash: hash(text),
      promptTokens,
      promptContentWords: contentWordCount(clean),
      phase: 'prompt',
      blocks: splitBlocks(text),
      ...this.names(),
    };
    if (this.opts.embedPrompts !== false) ev.promptEmbedding = embed(clean);
    return [ev];
  }

  private onAssistant(rec: any): TurnEvent[] {
    const msg = rec.message;
    if (!msg) return [];
    const ts = Date.parse(rec.timestamp ?? '') || Date.now();
    this.rememberToolUses(msg);
    this.noteActivity(msg);
    const id: string | undefined = msg.id;
    const usage = msg.usage;
    if (!id || !usage || this.seen.has(id)) return [];
    if (msg.model === '<synthetic>') return [];
    this.seen.add(id);
    if (this.turn === 0) this.turn = 1;
    const model: string = msg.model ?? this.lastModel;
    this.lastModel = model;
    const cc = usage.cache_creation ?? {};
    if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) this.cacheTtlMs = 60 * 60_000;
    else if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) this.cacheTtlMs = 5 * 60_000;
    const input = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const thinking = usage.output_tokens_details?.thinking_tokens;
    const ctx = input + cacheRead + cacheWrite + output;
    if (ctx > contextWindowFor(model, 'anthropic')) this.windowFloor = 1_000_000;
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
    const tools = this.toolsAvailable();
    return [
      {
        id: ulid(ts),
        source: 'claude-code',
        provider: 'anthropic',
        client: rec.entrypoint ?? 'claude-code',
        sessionId: rec.sessionId ?? this.sessionId ?? 'unknown',
        turn: this.turn,
        ts: new Date(ts).toISOString(),
        model,
        tokens: { input, output, cacheRead, cacheWrite, reasoning: thinking || undefined, estimated: false },
        contextSize: ctx,
        ...this.windowOf(model),
        idleSincePrevMs: idle,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        promptHash: '',
        cacheTtlMs: this.cacheTtlMs,
        phase: 'response',
        ...(tools.length ? { toolsAvailable: tools } : {}),
        ...this.names(),
      },
    ];
  }
}

/**
 * D-16 / CP-030.5: forma mínima de una llamada con uso: `message.id` y `message.usage` con
 * `input_tokens` y `output_tokens` numéricos (los de caché son opcionales, pero numéricos si están).
 * Un registro `assistant` con contenido y sin nada de esto es un cambio de formato, no una llamada vacía.
 */
function validUsage(msg: any): boolean {
  const u = msg.usage;
  if (typeof msg.id !== 'string' || !msg.id || !u || typeof u !== 'object') return false;
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return false;
  for (const k of ['cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (u[k] !== undefined && u[k] !== null && typeof u[k] !== 'number') return false;
  }
  return true;
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type === 'tool_result' ? textOf(b.content) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
