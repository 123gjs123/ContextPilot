import { embed } from '../embed.js';
import { estimateTokens } from '../estimate.js';
import { contextWindowFor, contextWindowInfo } from '../models.js';
import { redact } from '../redact.js';
import type { ToolCall, TurnEvent } from '../types.js';
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

  constructor(private opts: ClaudeCodeParserOptions = {}) {}

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
    if (rec.version) this.formatVersions.add(String(rec.version));
    if (rec.sessionId) this.sessionId = rec.sessionId;
    if (rec.isSidechain || this.opts.sidechain) return this.onSidechain(rec);
    if (rec.type === 'user') return this.onUser(rec);
    if (rec.type === 'assistant') return this.onAssistant(rec);
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
      phase: 'prompt',
      blocks: splitBlocks(text),
    };
    if (this.opts.embedPrompts !== false) ev.promptEmbedding = embed(clean);
    return [ev];
  }

  private onAssistant(rec: any): TurnEvent[] {
    const msg = rec.message;
    if (!msg) return [];
    const ts = Date.parse(rec.timestamp ?? '') || Date.now();
    this.rememberToolUses(msg);
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
      },
    ];
  }
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
