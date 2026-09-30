import { updateCentroid } from './embed.js';
import { effectiveTokens, pushBurnSample, rawTokens, sessionBurn, type Burn } from './projection.js';
import type { SessionState, TurnEvent } from './types.js';

// RF-EST-01: estado por sesión. applyEvent es pura: devuelve un estado nuevo.

export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_RECENT_TOOL_CALLS = 20;
const MAX_CACHE_RATIOS = 20;

export function promptTotal(e: Pick<TurnEvent, 'tokens'>): number {
  const t = e.tokens;
  return t.input + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
}

/** Proporción de caché del turno, o null si el turno es chico o no informa caché. */
export function cacheRatio(e: TurnEvent): number | null {
  const total = promptTotal(e);
  if (total < 2000 || e.tokens.estimated) return null;
  if (e.tokens.cacheRead === undefined && e.tokens.cacheWrite === undefined) return null;
  return (e.tokens.cacheRead ?? 0) / total;
}

export function newSession(e: TurnEvent): SessionState {
  return {
    sessionId: e.sessionId,
    source: e.source,
    provider: e.provider,
    client: e.client,
    model: e.model,
    startedAt: e.ts,
    lastTurnAt: e.ts,
    turns: 0,
    calls: 0,
    contextSize: 0,
    contextWindow: e.contextWindow,
    estimated: e.tokens.estimated,
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cacheRatios: [],
    cacheTtlMs: e.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    lastIdleMs: 0,
    recentToolCalls: [],
    toolsAvailable: [],
    toolLastUsedTurn: {},
    blockCounts: {},
    attachmentCounts: {},
    regenerations: 0,
    centroidN: 0,
    lastModel: e.model,
    lastPhase: 'response',
    status: 'active',
  };
}

export function applyEvent(prev: SessionState | undefined, e: TurnEvent): SessionState {
  if (e.sidechain) return applySidechain(prev, e);
  const s: SessionState = structuredClone(prev ?? newSession(e));
  s.lastIdleMs = e.idleSincePrevMs;
  if (e.windowSource) s.windowSource = e.windowSource;
  s.status = 'active';
  if (e.model) {
    // D-14: se recuerda cuándo cambió el modelo (R3 lista el cambio aunque haya ocurrido 2 turnos antes).
    if (prev && phaseOf(e) === 'response' && s.lastModel && s.lastModel !== e.model) {
      s.modelBefore = s.lastModel;
      s.modelChangedAtCall = s.calls + 1;
    }
    s.model = e.model;
    s.lastModel = e.model;
  }
  if (e.systemHash) {
    if (s.systemHash && s.systemHash !== e.systemHash) s.systemChangedAtCall = s.calls + 1;
    s.systemHash = e.systemHash;
  }
  if (e.contextWindow) s.contextWindow = e.contextWindow;
  if (e.cacheTtlMs) s.cacheTtlMs = e.cacheTtlMs;
  if (e.toolsAvailable?.length) s.toolsAvailable = e.toolsAvailable;

  const phase = e.phase ?? 'response';
  s.lastPhase = phase;

  if (phase === 'prompt') {
    if (e.promptTokens !== undefined) s.lastPromptTokens = e.promptTokens;
    if (e.promptEmbedding && (e.promptTokens ?? 99) >= 20) {
      s.centroid = updateCentroid(s.centroid, s.centroidN, e.promptEmbedding);
      s.centroidN += 1;
    }
    for (const b of e.blocks ?? []) {
      const c = (s.blockCounts[b.hash] ??= { count: 0, tokens: b.tokens });
      c.count += 1;
    }
    for (const a of e.attachments ?? []) s.attachmentCounts[a.hash] = (s.attachmentCounts[a.hash] ?? 0) + 1;
    return s;
  }

  s.turns = Math.max(s.turns, e.turn);
  s.calls += 1;
  s.lastTurnAt = e.ts;
  s.contextSize = e.contextSize;
  s.estimated = e.tokens.estimated;
  s.totals.input += e.tokens.input;
  s.totals.output += e.tokens.output;
  s.totals.cacheRead += e.tokens.cacheRead ?? 0;
  s.totals.cacheWrite += e.tokens.cacheWrite ?? 0;
  s.totals.reasoning += e.tokens.reasoning ?? 0;
  s.lastOutputTokens = e.tokens.output;
  pushBurnSample(s, Date.parse(e.ts), effectiveTokens(e.tokens), rawTokens(e.tokens));
  if (e.promptTokens !== undefined) s.lastPromptTokens = e.promptTokens;

  const ratio = cacheRatio(e);
  if (ratio !== null) {
    s.cacheRatios.push(ratio);
    if (s.cacheRatios.length > MAX_CACHE_RATIOS) s.cacheRatios.shift();
  }

  for (const tc of e.toolCalls ?? []) {
    s.recentToolCalls.push({ ...tc, ts: tc.ts ?? e.ts });
    s.toolLastUsedTurn[tc.name] = s.turns;
  }
  if (s.recentToolCalls.length > MAX_RECENT_TOOL_CALLS) {
    s.recentToolCalls.splice(0, s.recentToolCalls.length - MAX_RECENT_TOOL_CALLS);
  }

  s.regenerations = e.regenerated ? s.regenerations + 1 : 0;

  // Web: prompt y adjuntos llegan con la respuesta cuando no hubo evento 'prompt'.
  if (prev?.lastPhase !== 'prompt') {
    if (e.promptEmbedding && (e.promptTokens ?? 99) >= 20) {
      s.centroid = updateCentroid(s.centroid, s.centroidN, e.promptEmbedding);
      s.centroidN += 1;
    }
    for (const b of e.blocks ?? []) {
      const c = (s.blockCounts[b.hash] ??= { count: 0, tokens: b.tokens });
      c.count += 1;
    }
    for (const a of e.attachments ?? []) s.attachmentCounts[a.hash] = (s.attachmentCounts[a.hash] ?? 0) + 1;
  }
  return s;
}

/**
 * DECISIONS «subagentes»: una llamada de subagente suma a acumulados y a la historia de
 * herramientas (R5/R8), pero no toca contextSize, ventana, caché, modelo, turnos ni pausa del
 * hilo principal. Si la sesión padre aún no existe, se crea con contexto 0.
 */
function applySidechain(prev: SessionState | undefined, e: TurnEvent): SessionState {
  const s: SessionState = structuredClone(prev ?? { ...newSession(e), contextWindow: 0 });
  s.status = 'active';
  if (!prev || Date.parse(e.ts) > Date.parse(s.lastTurnAt)) s.lastTurnAt = e.ts;
  s.totals.input += e.tokens.input;
  s.totals.output += e.tokens.output;
  s.totals.cacheRead += e.tokens.cacheRead ?? 0;
  s.totals.cacheWrite += e.tokens.cacheWrite ?? 0;
  s.totals.reasoning += e.tokens.reasoning ?? 0;
  pushBurnSample(s, Date.parse(e.ts), effectiveTokens(e.tokens), rawTokens(e.tokens));
  for (const tc of e.toolCalls ?? []) {
    s.recentToolCalls.push({ ...tc, ts: tc.ts ?? e.ts });
    s.toolLastUsedTurn[tc.name] = s.turns;
  }
  if (s.recentToolCalls.length > MAX_RECENT_TOOL_CALLS) {
    s.recentToolCalls.splice(0, s.recentToolCalls.length - MAX_RECENT_TOOL_CALLS);
  }
  return s;
}

/** Vista compacta para UIs y statusline. */
export interface SessionView {
  sessionId: string;
  source: SessionState['source'];
  provider: SessionState['provider'];
  client: string;
  model: string;
  turns: number;
  contextSize: number;
  contextWindow: number;
  contextPct: number;
  cachePct: number | null;
  estimated: boolean;
  lastTurnAt: string;
  status: SessionState['status'];
  /** Extensión: origen de contextWindow. */
  windowSource?: SessionState['windowSource'];
  /** D-5 (CP-018.1): ritmo de la sesión, media móvil de 15 min. */
  burn?: Burn;
}

function phaseOf(e: TurnEvent): 'prompt' | 'response' {
  return e.phase ?? 'response';
}

export function toView(s: SessionState, now = Date.now()): SessionView {
  const last = s.cacheRatios.at(-1);
  return {
    sessionId: s.sessionId,
    source: s.source,
    provider: s.provider,
    client: s.client,
    model: s.model,
    turns: s.turns,
    contextSize: s.contextSize,
    contextWindow: s.contextWindow,
    contextPct: s.contextWindow ? s.contextSize / s.contextWindow : 0,
    cachePct: last ?? null,
    estimated: s.estimated,
    lastTurnAt: s.lastTurnAt,
    status: s.status,
    windowSource: s.windowSource,
    burn: sessionBurn(s, now),
  };
}
