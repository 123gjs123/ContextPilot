import { embed } from '../embed.js';
import { estimateTokens } from '../estimate.js';
import { contextWindowFor } from '../models.js';
import { redact } from '../redact.js';
import type { ToolCall, TurnEvent } from '../types.js';
import { hash, ulid } from '../util.js';
import { splitBlocks } from './blocks.js';

// RF-CAP-01: parser incremental de transcripts JSONL de Claude Code.
// - Un mensaje de API aparece en varias líneas (un bloque de contenido por línea) con el mismo
//   message.id y el mismo usage: se emite UN evento por message.id.
// - Resultados de herramientas llegan en el registro 'user' siguiente; se adjuntan al próximo
//   evento de respuesta (la llamada de API que los consumió).
// - Registros de subagentes (isSidechain) no cuentan para el contexto de la sesión principal.

interface PendingTool {
  name: string;
  argsHash: string;
}

export interface ClaudeCodeParserOptions {
  embedPrompts?: boolean;
}

export class ClaudeCodeParser {
  readonly formatVersions = new Set<string>();
  private seen = new Set<string>();
  private toolUses = new Map<string, PendingTool>();
  private pendingResults: ToolCall[] = [];
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
    if (rec.isSidechain) return [];
    if (rec.type === 'user') return this.onUser(rec);
    if (rec.type === 'assistant') return this.onAssistant(rec);
    return [];
  }

  private onUser(rec: any): TurnEvent[] {
    const content = rec.message?.content;
    const ts = Date.parse(rec.timestamp ?? '') || Date.now();
    if (Array.isArray(content)) {
      let hadToolResult = false;
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        hadToolResult = true;
        const tu = this.toolUses.get(block.tool_use_id);
        this.pendingResults.push({
          name: tu?.name ?? 'unknown',
          argsHash: tu?.argsHash ?? '',
          failed: block.is_error === true,
          resultTokens: estimateTokens(textOf(block.content)),
        });
      }
      if (hadToolResult) return [];
    }
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
      contextWindow: Math.max(this.windowFloor, contextWindowFor(this.lastModel, 'anthropic')),
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
    for (const block of msg.content ?? []) {
      if (block?.type === 'tool_use') {
        this.toolUses.set(block.id, { name: block.name, argsHash: hash(JSON.stringify(block.input ?? {})) });
      }
    }
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
        contextWindow: Math.max(this.windowFloor, contextWindowFor(model, 'anthropic')),
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
