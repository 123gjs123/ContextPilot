import { createHash } from 'node:crypto';
import { contextWindowFor, estimateTokens, type ToolCall, type TurnEvent } from '@contextpilot/core';

// Mapeo puro de registros `trees` del store de conversaciones de Claude Desktop a TurnEvent
// (docs/SPIKE-desktop-traffic.md §6). El texto sólo se usa en memoria para hashes y estimaciones.
// - cowork/code (tree.events del Agent SDK): un turno por evento `result`, con usage exacto.
// - chat (tree.chat_messages): un turno por mensaje del asistente en la rama actual; tokens estimados.

export const STORE_FORMAT = '2.2';

type Json = any;
type Draft = Omit<TurnEvent, 'turn'>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Texto plano de un `content` (string o bloques). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: Json) => (typeof b?.text === 'string' ? b.text : typeof b?.thinking === 'string' ? b.thinking : typeof b?.content === 'string' ? b.content : Array.isArray(b?.content) ? textOf(b.content) : ''))
    .join('\n');
}

const isDate = (s: unknown) => typeof s === 'string' && Number.isFinite(Date.parse(s));

export interface StoreRecord {
  conversationUuid: string;
  product: string;
  v?: string;
  tree?: Json;
}

export function isStoreRecord(v: unknown): v is StoreRecord {
  return !!v && typeof v === 'object' && typeof (v as Json).conversationUuid === 'string' && typeof (v as Json).product === 'string';
}

/** Turnos (sin número de turno: lo asigna el adaptador) de un registro con `tree`. */
export function turnsFromRecord(rec: StoreRecord): Draft[] {
  const t = rec.tree;
  if (!t || typeof t !== 'object') return [];
  if (Array.isArray(t.events)) return agentTurns(rec, t.events);
  if (Array.isArray(t.chat_messages)) return chatTurns(rec, t);
  return [];
}

function base(rec: StoreRecord, over: Partial<Draft>): Draft {
  return {
    id: '',
    source: 'desktop',
    provider: 'anthropic',
    client: 'claude-desktop',
    sessionId: rec.conversationUuid,
    ts: new Date().toISOString(),
    model: '',
    tokens: { input: 0, output: 0, estimated: true },
    contextSize: 0,
    contextWindow: 0,
    idleSincePrevMs: 0,
    promptHash: '',
    phase: 'response',
    ...over,
  } as Draft;
}

const PRODUCT_NAME: Record<string, string> = { cowork: 'Cowork', code: 'Code', chat: 'Chat' };

// ---------- cowork / code ----------

function agentTurns(rec: StoreRecord, events: Json[]): Draft[] {
  const evs = events.filter((e) => e && typeof e.seq === 'number' && e.payload).sort((a, b) => a.seq - b.seq);
  const out: Draft[] = [];
  let group: Json[] = [];
  let prevResult: Json | undefined;
  let initModel = '';
  for (const e of evs) {
    const p = e.payload;
    if (p.type === 'system' && p.subtype === 'init' && typeof p.model === 'string') initModel = p.model;
    if (p.type !== 'result') {
      group.push(e);
      continue;
    }
    const d = agentTurn(rec, e, group, prevResult, initModel);
    if (d) out.push(d);
    prevResult = e;
    group = [];
  }
  return out;
}

function agentTurn(rec: StoreRecord, res: Json, group: Json[], prev: Json | undefined, initModel: string): Draft | null {
  const p = res.payload;
  const u = p.usage;
  if (!u || typeof u.output_tokens !== 'number') return null;
  const main = group.filter((e) => e.payload.type === 'assistant' && !e.payload.parent_tool_use_id);
  const lastAssistant = main.at(-1)?.payload?.message;
  const model: string = lastAssistant?.model || initModel || Object.keys(p.modelUsage ?? {})[0] || 'claude';
  const it = Array.isArray(u.iterations) && u.iterations.length ? u.iterations.at(-1) : lastAssistant?.usage;
  const contextSize = it ? (it.input_tokens ?? 0) + (it.cache_read_input_tokens ?? 0) + (it.cache_creation_input_tokens ?? 0) + (it.output_tokens ?? 0) : 0;
  const window = p.modelUsage?.[model]?.contextWindow;

  // Prompt del usuario: primer `user` del grupo que no sea un tool_result.
  const promptEv = group.find((e) => e.payload.type === 'user' && !e.payload.parent_tool_use_id && !isToolResult(e.payload.message?.content));
  const prompt = promptEv ? textOf(promptEv.payload.message?.content) : '';

  // Herramientas: tool_use del asistente + tool_result del usuario.
  const results = new Map<string, Json>();
  for (const e of group) {
    if (e.payload.type !== 'user' || !Array.isArray(e.payload.message?.content)) continue;
    for (const b of e.payload.message.content) if (b?.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b);
  }
  const toolCalls: ToolCall[] = [];
  for (const e of group) {
    if (e.payload.type !== 'assistant' || !Array.isArray(e.payload.message?.content)) continue;
    for (const b of e.payload.message.content) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const r = results.get(b.id);
      toolCalls.push({
        name: b.name,
        argsHash: sha(JSON.stringify(b.input ?? {})),
        failed: !!r?.is_error,
        resultTokens: r ? estimateTokens(textOf(r.content)) : 0,
      });
    }
  }
  const startMs = promptEv?.serverCreatedAt;
  const prevMs = prev?.serverCreatedAt;
  const ts = typeof res.serverCreatedAt === 'number' ? res.serverCreatedAt : Date.now();
  return base(rec, {
    id: `cd:${rec.conversationUuid}:${res.dedupKey ?? p.uuid ?? res.seq}`,
    ts: new Date(ts).toISOString(),
    model,
    tokens: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      ...(u.output_tokens_details?.thinking_tokens ? { reasoning: u.output_tokens_details.thinking_tokens } : {}),
      estimated: false,
    },
    contextSize,
    contextWindow: typeof window === 'number' && window > 0 ? window : contextWindowFor(model, 'anthropic'),
    windowSource: typeof window === 'number' && window > 0 ? 'observed' : 'table',
    idleSincePrevMs: typeof startMs === 'number' && typeof prevMs === 'number' ? Math.max(0, startMs - prevMs) : 0,
    promptHash: prompt ? sha(norm(prompt)) : '',
    ...(prompt ? { promptTokens: estimateTokens(prompt) } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    project: PRODUCT_NAME[rec.product] ?? rec.product,
  });
}

function isToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 && content.every((b: Json) => b?.type === 'tool_result');
}

// ---------- chat ----------

function chatTurns(rec: StoreRecord, t: Json): Draft[] {
  const msgs: Json[] = t.chat_messages.filter((m: Json) => m && typeof m.uuid === 'string');
  const byId = new Map(msgs.map((m) => [m.uuid, m]));
  // Rama actual: desde la hoja hacia la raíz por parent_message_uuid.
  const branch: Json[] = [];
  let cur = byId.get(t.current_leaf_message_uuid) ?? msgs.at(-1);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.uuid)) {
    guard.add(cur.uuid);
    branch.unshift(cur);
    cur = byId.get(cur.parent_message_uuid);
  }
  const children = new Map<string, number>();
  for (const m of msgs) if (m.sender === 'assistant' && m.parent_message_uuid) children.set(m.parent_message_uuid, (children.get(m.parent_message_uuid) ?? 0) + 1);

  const model: string = typeof t.model === 'string' && t.model ? t.model : 'claude';
  const window = contextWindowFor(model, 'anthropic');
  const out: Draft[] = [];
  let ctx = 0;
  let prevStop: number | undefined;
  let human: Json | undefined;
  for (const m of branch) {
    const text = textOf(m.content) || (typeof m.text === 'string' ? m.text : '');
    const attach = [...(m.attachments ?? []), ...(m.files ?? [])];
    const attachTokens = attach.reduce((s: number, a: Json) => s + (typeof a?.extracted_content === 'string' ? estimateTokens(a.extracted_content) : typeof a?.file_size === 'number' ? Math.round(a.file_size / 4) : 0), 0);
    const tokens = estimateTokens(text) + attachTokens;
    if (m.sender !== 'assistant') {
      human = m;
      ctx += tokens;
      continue;
    }
    if (m.stop_reason == null) {
      // Respuesta todavía en curso: se toma cuando termine.
      continue;
    }
    const blocks: Json[] = Array.isArray(m.content) ? m.content : [];
    const stops = blocks.map((b) => (isDate(b?.stop_timestamp) ? Date.parse(b.stop_timestamp) : NaN)).filter(Number.isFinite);
    const endMs = stops.length ? Math.max(...stops) : Date.parse(m.updated_at ?? m.created_at) || Date.now();
    const humanText = human ? textOf(human.content) || (typeof human.text === 'string' ? human.text : '') : '';
    const humanMs = human && isDate(human.created_at) ? Date.parse(human.created_at) : undefined;
    const reasoning = blocks.filter((b) => b?.type === 'thinking').reduce((s, b) => s + estimateTokens(String(b.thinking ?? b.text ?? '')), 0);
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
      .map((b) => {
        const r = blocks.find((x) => x?.type === 'tool_result' && (x.tool_use_id === b.id || x.name === b.name));
        return { name: b.name, argsHash: sha(JSON.stringify(b.input ?? {})), failed: !!r?.is_error, resultTokens: r ? estimateTokens(textOf(r.content)) : 0 };
      });
    const input = ctx;
    ctx += tokens;
    out.push(
      base(rec, {
        id: `cd:${rec.conversationUuid}:${m.uuid}`,
        ts: new Date(endMs).toISOString(),
        model,
        tokens: { input, output: tokens, ...(reasoning ? { reasoning } : {}), estimated: true },
        contextSize: ctx,
        contextWindow: window,
        windowSource: 'table',
        idleSincePrevMs: humanMs !== undefined && prevStop !== undefined ? Math.max(0, humanMs - prevStop) : 0,
        promptHash: humanText ? sha(norm(humanText)) : '',
        ...(humanText ? { promptTokens: estimateTokens(humanText) } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...((children.get(m.parent_message_uuid) ?? 0) > 1 ? { regenerated: true } : {}),
        project: 'Chat',
        ...(typeof t.name === 'string' && t.name ? { title: t.name } : {}),
      }),
    );
    prevStop = endMs;
  }
  return out;
}
