import { describe, expect, it } from 'vitest';
import {
  activeSessions,
  initialState,
  markHandled,
  parseServerMsg,
  preferSuggestion,
  reduce,
  visibleSuggestion,
} from '../src/shared/store.js';
import { NOW, sess, sug } from './helpers.js';

const hello = (over: object = {}) => ({
  type: 'hello' as const,
  data: { version: '1', sessions: [sess()], suggestions: [sug()], health: [], ...over },
});

describe('store (CP-046.1)', () => {
  it('hello reemplaza estado y marca conectado', () => {
    const s = reduce(initialState(), hello());
    expect(s.connection).toBe('connected');
    expect(Object.keys(s.sessions)).toEqual(['s1']);
    expect(s.suggestions.s1?.id).toBe('g1');
  });

  it('session hace upsert', () => {
    let s = reduce(initialState(), hello());
    s = reduce(s, { type: 'session', data: sess({ contextPct: 0.8 }) });
    s = reduce(s, { type: 'session', data: sess({ sessionId: 's2' }) });
    expect(s.sessions.s1?.contextPct).toBe(0.8);
    expect(Object.keys(s.sessions).sort()).toEqual(['s1', 's2']);
  });

  it('máximo una sugerencia por sesión: gana severidad, luego ahorro', () => {
    let s = reduce(initialState(), hello({ suggestions: [] }));
    s = reduce(s, { type: 'suggestion', data: sug({ id: 'a', severity: 'info', estimatedSavingTokens: 99_999 }) });
    s = reduce(s, { type: 'suggestion', data: sug({ id: 'b', severity: 'critical' }) });
    s = reduce(s, { type: 'suggestion', data: sug({ id: 'c', severity: 'warn' }) });
    expect(s.suggestions.s1?.id).toBe('b');
    expect(preferSuggestion(sug({ id: 'x', estimatedSavingTokens: 10 }), sug({ id: 'y', estimatedSavingTokens: 20 })).id).toBe('y');
  });

  it('la misma id actualiza en lugar de competir', () => {
    let s = reduce(initialState(), hello());
    s = reduce(s, { type: 'suggestion', data: sug({ severity: 'info', title: 'nuevo' }) });
    expect(s.suggestions.s1?.title).toBe('nuevo');
  });

  it('suggestion-cleared quita sólo si coincide la id', () => {
    let s = reduce(initialState(), hello());
    s = reduce(s, { type: 'suggestion-cleared', data: { id: 'otra', sessionId: 's1' } });
    expect(s.suggestions.s1).toBeDefined();
    s = reduce(s, { type: 'suggestion-cleared', data: { id: 'g1', sessionId: 's1', feedback: 'accepted' } });
    expect(s.suggestions.s1).toBeUndefined();
  });

  it('feedback optimista: markHandled quita y no vuelve a aparecer', () => {
    let s = reduce(initialState(), hello());
    s = markHandled(s, 'g1');
    expect(s.suggestions.s1).toBeUndefined();
    s = reduce(s, { type: 'suggestion', data: sug() });
    expect(s.suggestions.s1).toBeUndefined();
  });

  it('vencidas y quiet no son visibles', () => {
    let s = reduce(initialState(), hello({ suggestions: [sug({ expiresAt: new Date(NOW - 1).toISOString() })] }));
    expect(visibleSuggestion(s, 's1', NOW)).toBeUndefined();
    s = reduce(s, { type: 'suggestion', data: sug({ id: 'q', quiet: true }) });
    expect(visibleSuggestion(s, 's1', NOW)).toBeUndefined();
  });

  it('activas = último turno < 30 min y no cerradas, más reciente primero', () => {
    const s = reduce(
      initialState(),
      hello({
        sessions: [
          sess({ sessionId: 'old', lastTurnAt: new Date(NOW - 31 * 60_000).toISOString() }),
          sess({ sessionId: 'closed', status: 'closed' }),
          sess({ sessionId: 'a', lastTurnAt: new Date(NOW - 5 * 60_000).toISOString() }),
          sess({ sessionId: 'b', lastTurnAt: new Date(NOW - 1 * 60_000).toISOString() }),
        ],
      }),
    );
    expect(activeSessions(s, NOW).map((x) => x.sessionId)).toEqual(['b', 'a']);
  });

  it('parseServerMsg descarta basura', () => {
    expect(parseServerMsg('no json')).toBeNull();
    expect(parseServerMsg('{"type":"otro","data":1}')).toBeNull();
    expect(parseServerMsg('{"type":"hello","data":{}}')).toBeNull();
    expect(parseServerMsg(JSON.stringify(hello()))?.type).toBe('hello');
  });
});
