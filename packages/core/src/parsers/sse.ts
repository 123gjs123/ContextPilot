import { estimateTokens } from '../estimate.js';
import type { Provider, TokenUsage } from '../types.js';
import { hash } from '../util.js';

// CP-036: extracción de uso desde respuestas del proxy (copia del stream, nunca el original).
// Formatos:
//   anthropic  Messages API SSE: message_start.message.{model,usage} + message_delta.usage
//              (output_tokens acumulado; versiones nuevas pueden repetir input/cache).
//   openai     Chat Completions SSE: chunk final con `usage` (stream_options.include_usage).
//              Responses API SSE: response.completed/incomplete/failed con response.usage.
//   google     streamGenerateContent?alt=sse: usageMetadata en los chunks (gana el último).
// También respuestas JSON no-stream de las tres APIs (extractUsageFromJson).

export interface DeclaredTool {
  name: string;
  definitionTokens: number;
}

export interface ExtractResult {
  model?: string;
  usage?: TokenUsage;
  text: string;
  toolsDeclared?: DeclaredTool[];
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parser SSE incremental genérico (líneas `event:` / `data:`, eventos separados por línea en blanco). */
export class SseParser {
  private buf = '';
  private event?: string;
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf.startsWith('\r\n', nl) ? 2 : 1;
      // Un \r al final del buffer puede ser la mitad de \r\n: esperar más datos.
      if (this.buf[nl] === '\r' && nl + 1 === this.buf.length) break;
      this.buf = this.buf.slice(nl + sepLen);
      this.line(line, out);
    }
    return out;
  }

  /** Fin del stream: emite el evento pendiente sin línea en blanco final. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) this.line(this.buf, out);
    this.buf = '';
    this.line('', out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.data.length) out.push({ event: this.event, data: this.data.join('\n') });
      this.data = [];
      this.event = undefined;
      return;
    }
    if (line.startsWith(':')) return;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
  }
}

interface Acc {
  model?: string;
  usage?: TokenUsage;
  text: string[];
}

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

// --- Normalización de usage por proveedor (types.ts: input = no cacheado) ---

export function anthropicUsage(u: any): TokenUsage {
  const r: TokenUsage = {
    input: n(u?.input_tokens),
    output: n(u?.output_tokens),
    cacheRead: n(u?.cache_read_input_tokens),
    cacheWrite: n(u?.cache_creation_input_tokens),
    estimated: false,
  };
  const thinking = n(u?.output_tokens_details?.thinking_tokens);
  if (thinking) r.reasoning = thinking;
  return r;
}

/** Chat Completions (prompt_tokens/completion_tokens) y Responses (input_tokens/output_tokens). */
export function openaiUsage(u: any): TokenUsage {
  const prompt = n(u?.prompt_tokens ?? u?.input_tokens);
  const cached = Math.min(prompt, n(u?.prompt_tokens_details?.cached_tokens ?? u?.input_tokens_details?.cached_tokens));
  const r: TokenUsage = {
    input: prompt - cached,
    output: n(u?.completion_tokens ?? u?.output_tokens),
    cacheRead: cached,
    estimated: false,
  };
  const reasoning = n(u?.completion_tokens_details?.reasoning_tokens ?? u?.output_tokens_details?.reasoning_tokens);
  if (reasoning) r.reasoning = reasoning;
  return r;
}

export function geminiUsage(u: any): TokenUsage {
  const prompt = n(u?.promptTokenCount) + n(u?.toolUsePromptTokenCount);
  const cached = Math.min(prompt, n(u?.cachedContentTokenCount));
  const r: TokenUsage = { input: prompt - cached, output: n(u?.candidatesTokenCount), cacheRead: cached, estimated: false };
  const thoughts = n(u?.thoughtsTokenCount);
  if (thoughts) r.reasoning = thoughts;
  return r;
}

function onAnthropic(acc: Acc, d: any): void {
  switch (d?.type) {
    case 'message_start': {
      const m = d.message ?? {};
      if (m.model) acc.model = m.model;
      if (m.usage) acc.usage = anthropicUsage(m.usage);
      break;
    }
    case 'message_delta': {
      const u = d.usage;
      if (!u) break;
      const base = acc.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: false };
      // output_tokens es acumulado; los demás campos sólo si vienen (versiones nuevas).
      acc.usage = {
        ...base,
        output: u.output_tokens !== undefined ? n(u.output_tokens) : base.output,
        input: u.input_tokens !== undefined && u.input_tokens !== null ? n(u.input_tokens) : base.input,
        cacheRead: u.cache_read_input_tokens != null ? n(u.cache_read_input_tokens) : base.cacheRead,
        cacheWrite: u.cache_creation_input_tokens != null ? n(u.cache_creation_input_tokens) : base.cacheWrite,
      };
      break;
    }
    case 'content_block_delta':
      if (d.delta?.type === 'text_delta' && typeof d.delta.text === 'string') acc.text.push(d.delta.text);
      break;
    case 'message': // JSON no-stream
      if (d.model) acc.model = d.model;
      if (d.usage) acc.usage = anthropicUsage(d.usage);
      for (const b of d.content ?? []) if (b?.type === 'text' && typeof b.text === 'string') acc.text.push(b.text);
      break;
  }
}

function onOpenai(acc: Acc, d: any): void {
  if (!d || typeof d !== 'object') return;
  // Responses API
  if (typeof d.type === 'string' && d.type.startsWith('response.')) {
    if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') acc.text.push(d.delta);
    const r = d.response;
    if (r?.model) acc.model = r.model;
    if (r?.usage && /^response\.(completed|incomplete|failed|done)$/.test(d.type)) acc.usage = openaiUsage(r.usage);
    return;
  }
  if (d.object === 'response') {
    // Responses API no-stream
    if (d.model) acc.model = d.model;
    if (d.usage) acc.usage = openaiUsage(d.usage);
    for (const item of d.output ?? [])
      for (const c of item?.content ?? []) if (c?.type === 'output_text' && typeof c.text === 'string') acc.text.push(c.text);
    return;
  }
  // Chat Completions (chunk o completo)
  if (d.model) acc.model = d.model;
  for (const ch of d.choices ?? []) {
    const t = ch?.delta?.content ?? ch?.message?.content;
    if (typeof t === 'string') acc.text.push(t);
  }
  if (d.usage) acc.usage = openaiUsage(d.usage);
}

function onGoogle(acc: Acc, d: any): void {
  if (Array.isArray(d)) {
    for (const x of d) onGoogle(acc, x);
    return;
  }
  if (!d || typeof d !== 'object') return;
  if (d.modelVersion) acc.model = d.modelVersion;
  for (const c of d.candidates ?? [])
    for (const p of c?.content?.parts ?? []) if (typeof p?.text === 'string' && !p.thought) acc.text.push(p.text);
  if (d.usageMetadata) acc.usage = geminiUsage(d.usageMetadata);
}

const HANDLERS: Record<Provider, (acc: Acc, d: any) => void> = {
  anthropic: onAnthropic,
  openai: onOpenai,
  google: onGoogle,
};

function result(acc: Acc): ExtractResult {
  const r: ExtractResult = { text: acc.text.join('') };
  if (acc.model) r.model = acc.model;
  if (acc.usage) r.usage = acc.usage;
  return r;
}

/**
 * Extractor incremental sobre la copia del stream. Tolera chunks partidos en cualquier byte,
 * `[DONE]`, comentarios y datos no JSON. Si el cuerpo no era SSE, end() intenta parsearlo como JSON.
 */
export function createUsageExtractor(provider: Provider): { push(chunk: string): void; end(): ExtractResult } {
  const sse = new SseParser();
  const acc: Acc = { text: [] };
  const handle = HANDLERS[provider];
  let raw = '';
  let sawEvents = false;
  const RAW_MAX = 8 * 1024 * 1024;
  const consume = (evs: SseEvent[]) => {
    for (const ev of evs) {
      sawEvents = true;
      if (!ev.data || ev.data === '[DONE]') continue;
      let d: unknown;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      handle(acc, d);
    }
  };
  return {
    push(chunk: string) {
      if (!sawEvents && raw.length < RAW_MAX) raw += chunk;
      consume(sse.push(chunk));
    },
    end() {
      consume(sse.end());
      if (!acc.usage && !acc.text.length) {
        try {
          return extractUsageFromJson(provider, JSON.parse(raw));
        } catch {
          /* ni SSE ni JSON: resultado vacío */
        }
      }
      return result(acc);
    },
  };
}

/** Respuesta no-stream (o array de chunks de Gemini sin alt=sse). */
export function extractUsageFromJson(provider: Provider, body: unknown): ExtractResult {
  const acc: Acc = { text: [] };
  if (provider === 'anthropic' && body && typeof body === 'object' && !(body as any).type) {
    onAnthropic(acc, { ...(body as object), type: 'message' });
  } else if (Array.isArray(body) && provider !== 'google') {
    for (const x of body) HANDLERS[provider](acc, x);
  } else {
    HANDLERS[provider](acc, body);
  }
  return result(acc);
}

// --- Pedido (proxy): modelo, estimación del prompt, herramientas declaradas, hashes de sesión ---

export interface RequestInfo {
  model?: string;
  promptTokensEstimate: number;
  toolsDeclared: DeclaredTool[];
  systemHash?: string;
  firstUserHash?: string;
  /** D-4: herramientas invocadas en el último mensaje del asistente del historial (uso para R6). */
  toolsUsed?: string[];
}

function textDeep(x: unknown): string {
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(textDeep).filter(Boolean).join('\n');
  if (x && typeof x === 'object') {
    const o = x as any;
    if (typeof o.text === 'string') return o.text;
    if (o.content !== undefined) return textDeep(o.content);
    if (o.parts !== undefined) return textDeep(o.parts);
    if (typeof o.input_text === 'string') return o.input_text;
  }
  return '';
}

const normHash = (s: string): string | undefined => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? hash(t) : undefined;
};

function tool(name: string, def: unknown, provider: Provider): DeclaredTool {
  return { name, definitionTokens: estimateTokens(JSON.stringify(def), provider) };
}

/** Modelo de Gemini desde la URL (`/v1beta/models/<modelo>:generateContent`). */
export function geminiModelFromUrl(url: string): string | undefined {
  const m = /models\/([^/:?]+)/.exec(url);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

export function requestInfo(provider: Provider, body: unknown, opts: { url?: string } = {}): RequestInfo {
  const b: any = body && typeof body === 'object' ? body : {};
  const out: RequestInfo = { promptTokensEstimate: 0, toolsDeclared: [] };
  let system = '';
  let firstUser = '';
  let all = '';

  if (provider === 'anthropic') {
    out.model = typeof b.model === 'string' ? b.model : undefined;
    system = textDeep(b.system);
    const msgs: any[] = Array.isArray(b.messages) ? b.messages : [];
    firstUser = textDeep(msgs.find((m) => m?.role === 'user')?.content);
    all = [system, ...msgs.map((m) => textDeep(m?.content))].join('\n');
    for (const t of Array.isArray(b.tools) ? b.tools : []) out.toolsDeclared.push(tool(String(t?.name ?? t?.type ?? 'tool'), t, provider));
    const lastAsst = [...msgs].reverse().find((m) => m?.role === 'assistant');
    out.toolsUsed = (Array.isArray(lastAsst?.content) ? lastAsst.content : [])
      .filter((c: any) => c?.type === 'tool_use' && typeof c.name === 'string')
      .map((c: any) => c.name as string);
  } else if (provider === 'openai') {
    out.model = typeof b.model === 'string' ? b.model : undefined;
    if (Array.isArray(b.messages)) {
      // Chat Completions
      const msgs: any[] = b.messages;
      system = msgs.filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => textDeep(m.content)).join('\n');
      firstUser = textDeep(msgs.find((m) => m?.role === 'user')?.content);
      all = msgs.map((m) => textDeep(m?.content)).join('\n');
      const lastAsst = [...msgs].reverse().find((m) => m?.role === 'assistant');
      out.toolsUsed = (Array.isArray(lastAsst?.tool_calls) ? lastAsst.tool_calls : [])
        .map((c: any) => c?.function?.name)
        .filter((n: unknown): n is string => typeof n === 'string');
    } else {
      // Responses API: instructions + input (string o lista de ítems)
      system = typeof b.instructions === 'string' ? b.instructions : '';
      const input: any[] = typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : Array.isArray(b.input) ? b.input : [];
      const sys = input.filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => textDeep(m.content));
      if (sys.length) system = [system, ...sys].filter(Boolean).join('\n');
      firstUser = textDeep(input.find((m) => m?.role === 'user')?.content);
      all = [system, ...input.map((m) => textDeep(m?.content ?? m?.output ?? ''))].join('\n');
      let lastUser = -1;
      input.forEach((m, i) => {
        if (m?.role === 'user') lastUser = i;
      });
      out.toolsUsed = input
        .slice(lastUser + 1)
        .filter((m) => m?.type === 'function_call' && typeof m.name === 'string')
        .map((m) => m.name as string);
    }
    for (const t of Array.isArray(b.tools) ? b.tools : []) {
      const name = t?.function?.name ?? t?.name ?? t?.type ?? 'tool';
      out.toolsDeclared.push(tool(String(name), t, provider));
    }
  } else {
    out.model = typeof b.model === 'string' ? b.model.replace(/^models\//, '') : opts.url ? geminiModelFromUrl(opts.url) : undefined;
    system = textDeep(b.systemInstruction ?? b.system_instruction);
    const contents: any[] = Array.isArray(b.contents) ? b.contents : [];
    firstUser = textDeep(contents.find((c) => (c?.role ?? 'user') === 'user'));
    all = [system, ...contents.map((c) => textDeep(c))].join('\n');
    const lastModel = [...contents].reverse().find((c) => c?.role === 'model');
    out.toolsUsed = (Array.isArray(lastModel?.parts) ? lastModel.parts : [])
      .map((p: any) => p?.functionCall?.name)
      .filter((n: unknown): n is string => typeof n === 'string');
    for (const t of Array.isArray(b.tools) ? b.tools : []) {
      const decls = t?.functionDeclarations ?? t?.function_declarations;
      if (Array.isArray(decls)) for (const d of decls) out.toolsDeclared.push(tool(String(d?.name ?? 'function'), d, provider));
      else if (t && typeof t === 'object') for (const k of Object.keys(t)) out.toolsDeclared.push(tool(k, t[k], provider));
    }
  }

  if (!out.toolsUsed?.length) delete out.toolsUsed;
  const toolTokens = out.toolsDeclared.reduce((s, t) => s + t.definitionTokens, 0);
  out.promptTokensEstimate = (all.trim() ? estimateTokens(all, provider) : 0) + toolTokens;
  const sh = normHash(system);
  const fh = normHash(firstUser);
  if (sh) out.systemHash = sh;
  if (fh) out.firstUserHash = fh;
  return out;
}

/** DECISIONS «sesión de proxy»: X-CP-Session o hash(proveedor + system + primer mensaje de usuario). */
export function proxySessionId(provider: Provider, info: Pick<RequestInfo, 'systemHash' | 'firstUserHash'>, header?: string | null): string {
  if (header && header.trim()) return header.trim();
  return `proxy:${provider}:${hash(`${provider}|${info.systemHash ?? ''}|${info.firstUserHash ?? ''}`)}`;
}
