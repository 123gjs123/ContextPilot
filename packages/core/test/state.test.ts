import { describe, expect, it } from 'vitest';
import { applyEvent, cacheRatio, contextWindowInfo, toView } from '../src/index.js';
import { ev, run } from './helpers.js';

describe('applyEvent (CP-007)', () => {
  const a = ev({ ts: '2026-09-29T10:00:00Z', contextSize: 50_000, tokens: { input: 1000, output: 500, cacheRead: 40_000, cacheWrite: 8500, estimated: false } });
  const b = ev({ ts: '2026-09-29T10:01:00Z', turn: 2, idleSincePrevMs: 60_000, contextSize: 60_000, tokens: { input: 200, output: 300, cacheRead: 55_000, cacheWrite: 4500, reasoning: 100, estimated: false } });

  it('contexto de la última llamada, acumulados y cacheRatio', () => {
    const { state } = run([a, b]);
    expect(state.contextSize).toBe(60_000);
    expect(state.totals).toEqual({ input: 1200, output: 800, cacheRead: 95_000, cacheWrite: 13_000, reasoning: 100 });
    expect(state.cacheRatios.at(-1)).toBeCloseTo(55_000 / (200 + 55_000 + 4500));
    expect(state.turns).toBe(2);
    expect(state.calls).toBe(2);
    expect(state.lastIdleMs).toBe(60_000);
    const v = toView(state);
    expect(v.contextPct).toBeCloseTo(60_000 / 200_000);
  });

  it('es pura: no muta el estado previo', () => {
    const s1 = run([a]).state;
    const copy = structuredClone(s1);
    applyEvent(s1, b);
    expect(s1).toEqual(copy);
  });

  it('prompt no suma tokens ni llamadas', () => {
    const { state } = run([a, ev({ phase: 'prompt', promptTokens: 30, tokens: { input: 0, output: 0, estimated: false } })]);
    expect(state.calls).toBe(1);
    expect(state.lastPromptTokens).toBe(30);
    expect(state.lastPhase).toBe('prompt');
  });

  it('cacheRatio null para turnos chicos o estimados', () => {
    expect(cacheRatio(ev({ tokens: { input: 100, output: 1, cacheRead: 100, estimated: false } }))).toBeNull();
    expect(cacheRatio(ev({ tokens: { input: 10_000, output: 1, cacheRead: 100, estimated: true } }))).toBeNull();
  });

  it('sidechain: suma totales y toolCalls, no toca contextSize/cacheRatios/turns/modelo', () => {
    const base = run([a, b]).state;
    const side = ev({
      sidechain: true,
      ts: '2026-09-29T10:02:00Z',
      model: 'claude-haiku-4-5',
      turn: 0,
      contextSize: 9000,
      contextWindow: 200_000,
      cacheTtlMs: 60 * 60_000,
      tokens: { input: 7000, output: 400, cacheRead: 1000, cacheWrite: 600, estimated: false },
      toolCalls: [{ name: 'Grep', resultTokens: 12_000, failed: false, argsHash: 'g' }],
    });
    const s = applyEvent(base, side);
    expect(s.contextSize).toBe(base.contextSize);
    expect(s.cacheRatios).toEqual(base.cacheRatios);
    expect(s.turns).toBe(base.turns);
    expect(s.calls).toBe(base.calls);
    expect(s.model).toBe(base.model);
    expect(s.cacheTtlMs).toBe(base.cacheTtlMs);
    expect(s.totals.input).toBe(base.totals.input + 7000);
    expect(s.totals.cacheWrite).toBe(base.totals.cacheWrite + 600);
    expect(s.recentToolCalls.at(-1)?.name).toBe('Grep');
    expect(s.lastTurnAt).toBe(side.ts);
  });

  it('sidechain antes del padre crea la sesión con contexto 0', () => {
    const s = applyEvent(undefined, ev({ sidechain: true, contextSize: 5000 }));
    expect(s.contextSize).toBe(0);
    expect(s.totals.input).toBe(100);
  });

  it('windowSource se propaga a estado y vista', () => {
    const s = applyEvent(undefined, ev({ windowSource: 'default' }));
    expect(toView(s).windowSource).toBe('default');
  });
});

describe('contextWindowInfo (DECISIONS «ventanas»)', () => {
  it('tabla, [1m], default, override, reportada y observada', () => {
    expect(contextWindowInfo('claude-sonnet-4-5', 'anthropic')).toEqual({ window: 200_000, source: 'table' });
    expect(contextWindowInfo('claude-opus-4-1[1m]', 'anthropic')).toEqual({ window: 1_000_000, source: 'table' });
    expect(contextWindowInfo('gemini-2.5-pro', 'google')).toEqual({ window: 1_048_576, source: 'table' });
    expect(contextWindowInfo('modelo-raro', 'anthropic')).toEqual({ window: 200_000, source: 'default' });
    expect(contextWindowInfo('modelo-raro', 'anthropic', { overrides: { 'modelo-raro': 500_000 } })).toEqual({ window: 500_000, source: 'table' });
    expect(contextWindowInfo('gpt-5-codex', 'openai', { reported: 272_000 })).toEqual({ window: 272_000, source: 'observed' });
    expect(contextWindowInfo('claude-sonnet-4-5', 'anthropic', { observedContext: 350_000 })).toEqual({ window: 1_000_000, source: 'observed' });
  });
});
