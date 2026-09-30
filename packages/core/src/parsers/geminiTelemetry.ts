import { embed } from '../embed.js';
import { estimateTokens } from '../estimate.js';
import { contextWindowInfo } from '../models.js';
import { redact } from '../redact.js';
import type { ToolCall, TurnEvent } from '../types.js';
import { hash, ulid } from '../util.js';

// RF-CAP-04 / CP-034: telemetría OTel de Gemini CLI.
// Entradas aceptadas por feed():
//   1. Registros de `telemetry.outfile` (exportador de archivo de Gemini CLI: cada log record es
//      un objeto JSON indentado; atributos planos {"event.name": ..., "session.id": ...}).
//   2. Payload OTLP/HTTP JSON completo: {resourceLogs:[{resource, scopeLogs:[{logRecords:[...]}]}]}
//      con atributos como [{key, value:{stringValue|intValue|doubleValue|boolValue}}].
//   3. Un logRecord OTLP suelto.
// Eventos usados:
//   gemini_cli.user_prompt  (prompt_length, prompt_id, prompt si logPrompts)
//   gemini_cli.tool_call    (function_name, function_args, success, duration_ms, prompt_id)
//   gemini_cli.api_response (model, input_token_count, output_token_count,
//                            cached_content_token_count, thoughts_token_count, tool_token_count,
//                            duration_ms, prompt_id, session.id)
// Uso: input = input_token_count − cached (input_token_count = promptTokenCount incluye caché),
// cacheRead = cached, output = output_token_count, reasoning = thoughts_token_count.
// Los tool_call se adjuntan a la siguiente api_response de la misma sesión.

type Attrs = Record<string, unknown>;

interface SessionCursor {
  turn: number;
  promptIds: Map<string, number>;
  pendingTools: ToolCall[];
  lastResponseTs?: number;
  promptTs?: number;
  model: string;
}

const SEEN_MAX = 2000;

export interface GeminiTelemetryParserOptions {
  embedPrompts?: boolean;
}

export class GeminiTelemetryParser {
  readonly formatVersions = new Set<string>();
  errors = 0;
  /** Registros sin event.name reconocible (métricas, spans, otros eventos). */
  ignored = 0;
  private sessions = new Map<string, SessionCursor>();
  private seen = new Set<string>();

  constructor(private opts: GeminiTelemetryParserOptions = {}) {}

  feed(record: unknown): TurnEvent[] {
    try {
      if (!record || typeof record !== 'object') {
        this.ignored++;
        return [];
      }
      const r = record as any;
      if (Array.isArray(r.resourceLogs)) return this.onOtlp(r);
      if (Array.isArray(record)) return (record as unknown[]).flatMap((x) => this.feed(x));
      return this.onRecord(r, {});
    } catch {
      this.errors++;
      return [];
    }
  }

  private onOtlp(payload: any): TurnEvent[] {
    const out: TurnEvent[] = [];
    for (const rl of payload.resourceLogs ?? []) {
      const resAttrs = attrsOf(rl?.resource?.attributes);
      for (const sl of rl?.scopeLogs ?? []) {
        if (sl?.scope?.version) this.formatVersions.add(`otlp:${sl.scope.version}`);
        for (const lr of sl?.logRecords ?? []) out.push(...this.onRecord(lr, resAttrs));
      }
    }
    return out;
  }

  private onRecord(r: any, resAttrs: Attrs): TurnEvent[] {
    const a: Attrs = { ...attrsOf(r.resource?.attributes), ...resAttrs, ...attrsOf(r.attributes) };
    const name = str(a['event.name']) ?? str(r.name) ?? str(r.eventName);
    if (!name?.startsWith('gemini_cli.')) {
      this.ignored++;
      return [];
    }
    const ver = str(a['service.version']) ?? str(r.instrumentationScope?.version);
    if (ver) this.formatVersions.add(ver);
    const ts = tsOf(r, a);
    const sessionId = str(a['session.id']) ?? 'unknown';
    // OTLP reintenta envíos: deduplicar por (evento, sesión, ts, prompt, tokens).
    const key = [name, sessionId, ts, str(a.prompt_id), a.input_token_count, a.output_token_count, a.function_name].join('|');
    if (this.seen.has(key)) return [];
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);

    const cur = this.cursor(sessionId);
    switch (name) {
      case 'gemini_cli.user_prompt':
        return this.onPrompt(cur, sessionId, a, ts);
      case 'gemini_cli.tool_call':
        cur.pendingTools.push({
          name: str(a.function_name) ?? 'unknown',
          argsHash: a.function_args === undefined ? '' : hash(typeof a.function_args === 'string' ? a.function_args : JSON.stringify(a.function_args)),
          failed: bool(a.success) === false,
          // La telemetría no informa el tamaño del resultado.
          resultTokens: 0,
        });
        return [];
      case 'gemini_cli.api_response':
        return this.onResponse(cur, sessionId, a, ts);
      case 'gemini_cli.config':
        if (str(a.model)) cur.model = str(a.model)!;
        return [];
      default:
        return [];
    }
  }

  private cursor(sessionId: string): SessionCursor {
    let c = this.sessions.get(sessionId);
    if (!c) {
      c = { turn: 0, promptIds: new Map(), pendingTools: [], model: '' };
      this.sessions.set(sessionId, c);
    }
    return c;
  }

  private turnFor(cur: SessionCursor, promptId: string | undefined, isPrompt: boolean): number {
    if (promptId && cur.promptIds.has(promptId)) return cur.promptIds.get(promptId)!;
    if (isPrompt || cur.turn === 0) cur.turn += 1;
    if (promptId) cur.promptIds.set(promptId, cur.turn);
    if (cur.promptIds.size > 500) cur.promptIds.delete(cur.promptIds.keys().next().value as string);
    return cur.turn;
  }

  private onPrompt(cur: SessionCursor, sessionId: string, a: Attrs, ts: number): TurnEvent[] {
    const promptId = str(a.prompt_id);
    const turn = this.turnFor(cur, promptId, true);
    const text = str(a.prompt);
    cur.promptTs = ts;
    const win = contextWindowInfo(cur.model, 'google');
    const ev: TurnEvent = {
      id: ulid(ts),
      source: 'gemini-cli',
      provider: 'google',
      client: 'gemini-cli',
      sessionId,
      turn,
      ts: new Date(ts).toISOString(),
      model: cur.model,
      tokens: { input: 0, output: 0, estimated: false },
      contextSize: 0,
      contextWindow: win.window,
      windowSource: win.source,
      idleSincePrevMs: cur.lastResponseTs ? Math.max(0, ts - cur.lastResponseTs) : 0,
      // Sin logPrompts no hay texto: el hash identifica el prompt por su id.
      promptHash: text ? hash(text) : hash(`prompt_id:${promptId ?? ts}`),
      promptTokens: text ? estimateTokens(text, 'google') : Math.round((num(a.prompt_length) || 0) / 4),
      phase: 'prompt',
    };
    if (text && this.opts.embedPrompts !== false) ev.promptEmbedding = embed(redact(text));
    return [ev];
  }

  private onResponse(cur: SessionCursor, sessionId: string, a: Attrs, ts: number): TurnEvent[] {
    const model = str(a.model) ?? cur.model;
    cur.model = model;
    const promptAll = num(a.input_token_count);
    const cached = Math.min(num(a.cached_content_token_count), promptAll);
    const output = num(a.output_token_count);
    const thoughts = num(a.thoughts_token_count);
    const toolTok = num(a.tool_token_count);
    const turn = this.turnFor(cur, str(a.prompt_id), false);
    const ctx = promptAll + toolTok + output;
    const win = contextWindowInfo(model, 'google', { observedContext: ctx });
    const idle =
      cur.promptTs !== undefined
        ? Math.max(0, cur.promptTs - (cur.lastResponseTs ?? cur.promptTs))
        : cur.lastResponseTs
          ? Math.max(0, ts - cur.lastResponseTs)
          : 0;
    cur.promptTs = undefined;
    cur.lastResponseTs = ts;
    const toolCalls = cur.pendingTools;
    cur.pendingTools = [];
    return [
      {
        id: ulid(ts),
        source: 'gemini-cli',
        provider: 'google',
        client: 'gemini-cli',
        sessionId,
        turn,
        ts: new Date(ts).toISOString(),
        model,
        tokens: {
          input: promptAll - cached,
          output,
          cacheRead: cached,
          reasoning: thoughts || undefined,
          estimated: false,
        },
        contextSize: ctx,
        contextWindow: win.window,
        windowSource: win.source,
        idleSincePrevMs: idle,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        promptHash: '',
        phase: 'response',
      },
    ];
  }
}

/** Atributos planos desde objeto plano u OTLP [{key, value:{...Value}}]. */
export function attrsOf(x: unknown): Attrs {
  if (!x) return {};
  if (Array.isArray(x)) {
    const out: Attrs = {};
    for (const kv of x) if (kv && typeof kv.key === 'string') out[kv.key] = anyValue(kv.value);
    return out;
  }
  if (typeof x === 'object') {
    const out: Attrs = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[k] = isAnyValue(v) ? anyValue(v) : v;
    return out;
  }
  return {};
}

function isAnyValue(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && /^(string|int|double|bool|array|kvlist|bytes)Value$/.test(keys[0]!);
}

function anyValue(v: any): unknown {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ('kvlistValue' in v) return attrsOf(v.kvlistValue?.values);
  return v;
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x ? x : undefined;
}

function num(x: unknown): number {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function bool(x: unknown): boolean | undefined {
  if (typeof x === 'boolean') return x;
  if (x === 'true') return true;
  if (x === 'false') return false;
  return undefined;
}

function tsOf(r: any, a: Attrs): number {
  const iso = str(a['event.timestamp']);
  if (iso && !Number.isNaN(Date.parse(iso))) return Date.parse(iso);
  for (const k of ['timeUnixNano', 'observedTimeUnixNano']) {
    const n = Number(r[k]);
    if (Number.isFinite(n) && n > 0) return Math.floor(n / 1e6);
  }
  for (const k of ['hrTime', 'hrTimeObserved']) {
    const hr = r[k];
    if (Array.isArray(hr) && hr.length === 2) return hr[0] * 1000 + Math.floor(hr[1] / 1e6);
  }
  return Date.now();
}

/**
 * Divide texto con objetos JSON concatenados (indentados o no, sin separador garantizado), como
 * escribe el exportador de archivo de Gemini CLI. Ignora fragmentos no parseables.
 */
export function parseGeminiOutfile(text: string): unknown[] {
  const s = new GeminiOutfileSplitter();
  const out = s.push(text);
  return out;
}

/** Versión incremental para el tailer: acumula hasta cerrar cada objeto de nivel superior. */
export class GeminiOutfileSplitter {
  private buf = '';
  private depth = 0;
  private inStr = false;
  private esc = false;
  private start = -1;
  private pos = 0;
  errors = 0;

  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    const b = this.buf;
    for (let i = this.pos; i < b.length; i++) {
      const c = b[i];
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === '\\') this.esc = true;
        else if (c === '"') this.inStr = false;
        continue;
      }
      if (c === '"') {
        if (this.depth > 0) this.inStr = true;
      } else if (c === '{' || c === '[') {
        if (this.depth === 0) this.start = i;
        this.depth++;
      } else if (c === '}' || c === ']') {
        if (this.depth === 0) continue;
        this.depth--;
        if (this.depth === 0 && this.start >= 0) {
          try {
            out.push(JSON.parse(b.slice(this.start, i + 1)));
          } catch {
            this.errors++;
          }
          this.start = -1;
        }
      }
    }
    // Conservar sólo el objeto incompleto.
    if (this.depth > 0 && this.start >= 0) {
      this.buf = b.slice(this.start);
      this.pos = this.buf.length;
      this.start = 0;
    } else {
      this.buf = '';
      this.pos = 0;
    }
    return out;
  }
}
