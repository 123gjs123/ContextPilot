import type { AdapterHealth, Connection, ServerMsg, SessionView, Suggestion } from './types.js';

// Estado del cliente desktop a partir de los mensajes WS del daemon (CP-046.1). Puro y sin Electron.

export const ACTIVE_WINDOW_MS = 30 * 60_000;
const SEVERITY_RANK = { info: 1, warn: 2, critical: 3 } as const;

export interface DesktopState {
  connection: Connection;
  lastError?: string;
  daemonVersion?: string;
  sessions: Record<string, SessionView>;
  /** Sugerencia vigente por sesión (máx. una, RNF-13). */
  suggestions: Record<string, Suggestion>;
  health: AdapterHealth[];
  /** Ids ya descartados localmente (feedback optimista) para no re-mostrarlos si el daemon los reenvía. */
  handled: string[];
}

export function initialState(): DesktopState {
  return { connection: 'connecting', sessions: {}, suggestions: {}, health: [], handled: [] };
}

/** Desempate de DECISIONS: gana mayor severidad; empate → mayor ahorro estimado; empate → la más nueva. */
export function preferSuggestion(a: Suggestion | undefined, b: Suggestion): Suggestion {
  if (!a) return b;
  const ra = SEVERITY_RANK[a.severity];
  const rb = SEVERITY_RANK[b.severity];
  if (rb !== ra) return rb > ra ? b : a;
  const sa = a.estimatedSavingTokens ?? 0;
  const sb = b.estimatedSavingTokens ?? 0;
  if (sb !== sa) return sb > sa ? b : a;
  return b;
}

function putSuggestion(map: Record<string, Suggestion>, s: Suggestion, handled: string[]): void {
  if (handled.includes(s.id)) return;
  const cur = map[s.sessionId];
  // Misma id: actualización del daemon; se reemplaza.
  map[s.sessionId] = cur && cur.id === s.id ? s : preferSuggestion(cur, s);
}

export function reduce(state: DesktopState, msg: ServerMsg): DesktopState {
  switch (msg.type) {
    case 'hello': {
      const sessions: Record<string, SessionView> = {};
      for (const s of msg.data.sessions) sessions[s.sessionId] = s;
      const suggestions: Record<string, Suggestion> = {};
      for (const s of msg.data.suggestions) putSuggestion(suggestions, s, state.handled);
      return {
        ...state,
        connection: 'connected',
        lastError: undefined,
        daemonVersion: msg.data.version,
        sessions,
        suggestions,
        health: msg.data.health,
      };
    }
    case 'session':
      return { ...state, sessions: { ...state.sessions, [msg.data.sessionId]: msg.data } };
    case 'suggestion': {
      const suggestions = { ...state.suggestions };
      putSuggestion(suggestions, msg.data, state.handled);
      return { ...state, suggestions };
    }
    case 'suggestion-cleared': {
      const cur = state.suggestions[msg.data.sessionId];
      if (!cur || cur.id !== msg.data.id) return state;
      const suggestions = { ...state.suggestions };
      delete suggestions[msg.data.sessionId];
      return { ...state, suggestions };
    }
    case 'health':
      return { ...state, health: msg.data };
    default:
      return state;
  }
}

/** Feedback optimista: la sugerencia desaparece de inmediato aunque el daemon tarde en confirmar. */
export function markHandled(state: DesktopState, suggestionId: string): DesktopState {
  const suggestions = { ...state.suggestions };
  for (const [sid, s] of Object.entries(suggestions)) if (s.id === suggestionId) delete suggestions[sid];
  const handled = [...state.handled, suggestionId].slice(-500);
  return { ...state, suggestions, handled };
}

export function setConnection(state: DesktopState, connection: Connection, lastError?: string): DesktopState {
  return { ...state, connection, lastError };
}

/** Parseo defensivo de un mensaje WS; mensajes desconocidos o mal formados → null. */
export function parseServerMsg(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw) as { type?: unknown; data?: unknown };
    if (!m || typeof m !== 'object' || typeof m.type !== 'string' || m.data === undefined) return null;
    if (!['hello', 'session', 'suggestion', 'suggestion-cleared', 'health'].includes(m.type)) return null;
    if (m.type === 'hello') {
      const d = m.data as Record<string, unknown>;
      if (!Array.isArray(d.sessions) || !Array.isArray(d.suggestions) || !Array.isArray(d.health)) return null;
    }
    return m as ServerMsg;
  } catch {
    return null;
  }
}

export function isActive(s: SessionView, now: number): boolean {
  if (s.status === 'closed') return false;
  const t = Date.parse(s.lastTurnAt);
  return Number.isFinite(t) ? now - t < ACTIVE_WINDOW_MS : s.status === 'active';
}

export function activeSessions(state: DesktopState, now: number): SessionView[] {
  return Object.values(state.sessions)
    .filter((s) => isActive(s, now))
    .sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt));
}

/** Sugerencia vigente de la sesión (no vencida). Las `quiet` no se muestran en tray/overlay (RF-REG-04). */
export function visibleSuggestion(state: DesktopState, sessionId: string, now: number): Suggestion | undefined {
  const s = state.suggestions[sessionId];
  if (!s || s.quiet) return undefined;
  const exp = Date.parse(s.expiresAt);
  if (Number.isFinite(exp) && exp <= now) return undefined;
  return s;
}

export function findSuggestion(state: DesktopState, id: string): Suggestion | undefined {
  return Object.values(state.suggestions).find((s) => s.id === id);
}
