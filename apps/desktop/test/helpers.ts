import type { SessionView, Suggestion } from '../src/shared/types.js';

export const NOW = Date.parse('2026-09-30T12:00:00Z');

export function sess(p: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1',
    source: 'claude-code',
    provider: 'anthropic',
    client: 'claude-code',
    model: 'claude-opus-4',
    turns: 3,
    contextSize: 60_000,
    contextWindow: 200_000,
    contextPct: 0.3,
    cachePct: 0.9,
    estimated: false,
    lastTurnAt: new Date(NOW - 60_000).toISOString(),
    status: 'active',
    ...p,
  };
}

export function sug(p: Partial<Suggestion> = {}): Suggestion {
  return {
    id: 'g1',
    ruleId: 'R1',
    sessionId: 's1',
    severity: 'warn',
    title: 'Compactar',
    detail: 'Contexto alto',
    actions: [{ kind: 'copy', label: 'Copiar /compact', payload: '/compact' }],
    expiresAt: new Date(NOW + 600_000).toISOString(),
    ...p,
  };
}
