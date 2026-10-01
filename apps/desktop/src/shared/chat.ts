// Chat de ContextPilot: estado de una conversación manejada por el `claude` CLI en modo
// `-p --input-format stream-json --output-format stream-json --include-partial-messages
// --permission-prompts host`. Puro (se testea sin Electron): eventos del CLI → mensajes,
// herramientas, pedidos de permiso y resultado del turno. El texto vive sólo en memoria: se
// reconstruye del transcript de Claude Code al reabrir (nunca se persiste en ContextPilot).

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; inputJson?: string; result?: string; isError?: boolean; done: boolean };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: ChatBlock[];
  ts: string;
  streaming?: boolean;
  /** El texto llegó por streaming: el evento `assistant` completo sólo aporta herramientas. */
  streamed?: boolean;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
}

export interface TurnResult {
  isError: boolean;
  subtype: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
}

export type ChatStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

export interface ChatState {
  id: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  status: ChatStatus;
  /** Detalle de estado del CLI («requesting», «compacting»…) o del error. */
  statusText?: string;
  messages: ChatMessage[];
  pending: PermissionRequest[];
  skills: string[];
  slashCommands: string[];
  mcp: { name: string; status: string }[];
  lastResult?: TurnResult;
  /** Uso del plan en vivo (`rate_limit_event`), fracciones 0..1. */
  rateLimit?: { fiveHour?: number; sevenDay?: number; resetsAt?: number };
}

export function newChatState(id: string, cwd: string, model?: string, sessionId?: string): ChatState {
  return { id, cwd, model, sessionId, status: 'idle', messages: [], pending: [], skills: [], slashCommands: [], mcp: [] };
}

const MAX_RESULT_CHARS = 4000;

type Json = any;

function clip(s: string): string {
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n… (${s.length - MAX_RESULT_CHARS} caracteres más)` : s;
}

/** Texto de un tool_result (string o bloques). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: Json) => (typeof b?.text === 'string' ? b.text : b?.type === 'image' ? '[imagen]' : '')).join('\n');
}

function findTool(s: ChatState, toolId: string): Extract<ChatBlock, { kind: 'tool' }> | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    for (const b of s.messages[i]!.blocks) if (b.kind === 'tool' && b.id === toolId) return b;
  }
  return undefined;
}

/** Bloques a partir del `content` de un mensaje del asistente (tool_use, text, thinking). */
function blocksFrom(content: unknown): ChatBlock[] {
  if (!Array.isArray(content)) return typeof content === 'string' && content ? [{ kind: 'text', text: content }] : [];
  const out: ChatBlock[] = [];
  for (const b of content as Json[]) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push({ kind: 'text', text: b.text });
    else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) out.push({ kind: 'thinking', text: b.thinking });
    else if (b?.type === 'tool_use') out.push({ kind: 'tool', id: String(b.id), name: String(b.name), input: b.input ?? {}, done: false });
  }
  return out;
}

/**
 * Aplica un evento del CLI. Muta y devuelve el mismo estado (lo llama el proceso principal en
 * caliente, con decenas de eventos por segundo). Los subagentes (`parent_tool_use_id`) no se
 * muestran como mensajes: su trabajo queda dentro de la herramienta Task que los lanzó.
 */
export function applyCliEvent(s: ChatState, m: Json, now = new Date().toISOString()): ChatState {
  if (!m || typeof m !== 'object') return s;
  if (m.parent_tool_use_id) return s;
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        if (typeof m.session_id === 'string') s.sessionId = m.session_id;
        if (typeof m.model === 'string') s.model = m.model;
        if (Array.isArray(m.skills)) s.skills = m.skills.map(String);
        if (Array.isArray(m.slash_commands)) s.slashCommands = m.slash_commands.map(String);
        if (Array.isArray(m.mcp_servers)) s.mcp = m.mcp_servers.map((x: Json) => ({ name: String(x?.name), status: String(x?.status ?? '') }));
        if (s.status === 'starting') s.status = 'running';
      } else if (m.subtype === 'status') {
        s.statusText = typeof m.status === 'string' ? m.status : undefined;
      } else if (m.subtype === 'compact_boundary') {
        s.messages.push({ id: `sys-${s.messages.length}`, role: 'system', blocks: [{ kind: 'text', text: 'Contexto compactado' }], ts: now });
      }
      return s;
    case 'stream_event':
      return applyStream(s, m.event, now);
    case 'assistant': {
      const msg = m.message ?? {};
      const id = String(msg.id ?? m.uuid ?? `a-${s.messages.length}`);
      let cur = s.messages.find((x) => x.id === id);
      if (!cur) {
        cur = { id, role: 'assistant', blocks: [], ts: now };
        s.messages.push(cur);
      }
      for (const b of blocksFrom(msg.content)) {
        if (b.kind === 'tool') {
          const t = cur.blocks.find((x) => x.kind === 'tool' && x.id === b.id) as Extract<ChatBlock, { kind: 'tool' }> | undefined;
          if (t) {
            t.input = b.input;
            t.inputJson = undefined;
          } else cur.blocks.push(b);
        } else if (!cur.streamed && !cur.blocks.some((x) => x.kind === b.kind && x.text === b.text)) {
          // Sin streaming de ese mensaje: el evento completo trae el texto.
          cur.blocks.push(b);
        }
      }
      return s;
    }
    case 'user': {
      const content = m.message?.content;
      if (!Array.isArray(content)) return s;
      for (const b of content as Json[]) {
        if (b?.type !== 'tool_result') continue;
        const t = findTool(s, String(b.tool_use_id));
        if (!t) continue;
        t.result = clip(toolResultText(b.content));
        t.isError = !!b.is_error;
        t.done = true;
      }
      return s;
    }
    case 'control_request':
      if (m.request?.subtype === 'can_use_tool' && typeof m.request_id === 'string') {
        s.pending.push({ requestId: m.request_id, toolName: String(m.request.tool_name ?? 'herramienta'), input: m.request.input ?? {} });
      }
      return s;
    case 'control_cancel_request':
      s.pending = s.pending.filter((p) => p.requestId !== m.request_id);
      return s;
    case 'rate_limit_event': {
      const w = m.rate_limit_info?.unifiedWindows ?? {};
      s.rateLimit = {
        fiveHour: typeof w.five_hour?.utilization === 'number' ? w.five_hour.utilization : s.rateLimit?.fiveHour,
        sevenDay: typeof w.seven_day?.utilization === 'number' ? w.seven_day.utilization : s.rateLimit?.sevenDay,
        resetsAt: typeof m.rate_limit_info?.resetsAt === 'number' ? m.rate_limit_info.resetsAt : s.rateLimit?.resetsAt,
      };
      return s;
    }
    case 'result': {
      const u = m.usage ?? {};
      s.lastResult = {
        isError: !!m.is_error,
        subtype: String(m.subtype ?? ''),
        durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : undefined,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
      };
      for (const x of s.messages) x.streaming = false;
      s.pending = [];
      s.status = 'idle';
      s.statusText = m.is_error ? String(m.result ?? m.subtype ?? 'error') : undefined;
      return s;
    }
    default:
      return s;
  }
}

function applyStream(s: ChatState, ev: Json, now: string): ChatState {
  if (!ev || typeof ev !== 'object') return s;
  const last = s.messages.at(-1);
  switch (ev.type) {
    case 'message_start': {
      const id = String(ev.message?.id ?? `a-${s.messages.length}`);
      if (!s.messages.some((x) => x.id === id)) s.messages.push({ id, role: 'assistant', blocks: [], ts: now, streaming: true, streamed: true });
      return s;
    }
    case 'content_block_start': {
      if (!last || last.role !== 'assistant') return s;
      const cb = ev.content_block ?? {};
      if (cb.type === 'text') last.blocks.push({ kind: 'text', text: cb.text ?? '' });
      else if (cb.type === 'thinking') last.blocks.push({ kind: 'thinking', text: cb.thinking ?? '' });
      else if (cb.type === 'tool_use') last.blocks.push({ kind: 'tool', id: String(cb.id), name: String(cb.name), input: {}, inputJson: '', done: false });
      return s;
    }
    case 'content_block_delta': {
      if (!last || last.role !== 'assistant') return s;
      const b = last.blocks.at(-1);
      const d = ev.delta ?? {};
      if (!b) return s;
      if (d.type === 'text_delta' && b.kind === 'text') b.text += d.text ?? '';
      else if (d.type === 'thinking_delta' && b.kind === 'thinking') b.text += d.thinking ?? '';
      else if (d.type === 'input_json_delta' && b.kind === 'tool') b.inputJson = (b.inputJson ?? '') + (d.partial_json ?? '');
      return s;
    }
    case 'content_block_stop': {
      const b = last?.blocks.at(-1);
      if (b?.kind === 'tool' && b.inputJson) {
        try {
          b.input = JSON.parse(b.inputJson);
          b.inputJson = undefined;
        } catch {
          // queda el JSON parcial; el evento `assistant` completo lo corrige
        }
      }
      return s;
    }
    case 'message_stop':
      if (last) last.streaming = false;
      return s;
    default:
      return s;
  }
}

/** Agrega el mensaje del usuario y deja la conversación «corriendo». */
export function addUserMessage(s: ChatState, text: string, now = new Date().toISOString()): ChatState {
  s.messages.push({ id: `u-${s.messages.length}-${Date.parse(now) || 0}`, role: 'user', blocks: [{ kind: 'text', text }], ts: now });
  s.status = s.status === 'idle' || s.status === 'exited' ? 'starting' : s.status;
  if (s.status === 'starting' && s.sessionId) s.status = 'running';
  s.statusText = undefined;
  return s;
}

// ---------- mensajes hacia el CLI (una línea JSON cada uno) ----------

export function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

export function permissionLine(requestId: string, allow: boolean, input: unknown): string {
  const response = allow ? { behavior: 'allow', updatedInput: input ?? {} } : { behavior: 'deny', message: 'El usuario lo denegó desde ContextPilot' };
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
}

/** Argumentos del CLI. `model` y `resume` se validan: van a una línea de comando. */
export function cliArgs(o: { model?: string; resume?: string }): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompts', 'host'];
  if (o.model && /^[A-Za-z0-9._\-[\]]+$/.test(o.model)) args.push('--model', o.model);
  if (o.resume && /^[0-9a-f-]{36}$/i.test(o.resume)) args.push('--resume', o.resume);
  return args;
}

// ---------- historial desde el transcript de Claude Code ----------

/** Carpeta de proyectos de Claude Code para un cwd (misma codificación que usa el CLI). */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Mensajes a mostrar a partir de las líneas del transcript (`<sessionId>.jsonl`). Sólo el hilo
 * principal (sin sidechains) y sin mensajes de sistema internos.
 */
export function messagesFromTranscript(lines: string[]): ChatMessage[] {
  const s = newChatState('t', '');
  for (const line of lines) {
    let r: Json;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || r.isSidechain || r.isMeta) continue;
    const ts = typeof r.timestamp === 'string' ? r.timestamp : new Date(0).toISOString();
    if (r.type === 'user') {
      const c = r.message?.content;
      if (typeof c === 'string') {
        if (!c.startsWith('<')) s.messages.push({ id: String(r.uuid), role: 'user', blocks: [{ kind: 'text', text: c }], ts });
      } else if (Array.isArray(c)) {
        const texts = c.filter((b: Json) => b?.type === 'text' && typeof b.text === 'string' && !b.text.startsWith('<')).map((b: Json) => b.text);
        if (texts.length) s.messages.push({ id: String(r.uuid), role: 'user', blocks: [{ kind: 'text', text: texts.join('\n') }], ts });
        applyCliEvent(s, { type: 'user', message: { content: c } });
      }
    } else if (r.type === 'assistant') {
      applyCliEvent(s, { type: 'assistant', message: r.message, uuid: r.uuid }, ts);
    }
  }
  for (const m of s.messages) for (const b of m.blocks) if (b.kind === 'tool') b.done = true;
  return s.messages;
}
