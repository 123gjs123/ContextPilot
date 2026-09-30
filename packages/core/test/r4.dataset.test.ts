import { describe, expect, it } from 'vitest';
import { R4, R4_COSINE, applyEvent, embed, estimateTokens, redact, type SessionState, type TurnEvent } from '../src/index.js';
import { ev, fixture } from './helpers.js';

// CP-019.2 / D-6: precisión de R4 sobre 100 casos etiquetados (fixtures/r4/cases.json), evaluando la
// regla real (centroide de prompts previos, gating de tokens/contexto incluido).

interface Dataset {
  contexts: { id: string; prev: string[] }[];
  cases: { id: number; ctx: string; label: 'same' | 'new'; prompt: string }[];
}

const data = JSON.parse(fixture('r4/cases.json')) as Dataset;

const promptEv = (text: string): TurnEvent =>
  ev({
    phase: 'prompt',
    promptEmbedding: embed(redact(text)),
    promptTokens: estimateTokens(text),
    tokens: { input: 0, output: 0, estimated: false },
    contextSize: 0,
  });

function sessionFor(prev: string[]): SessionState {
  let s: SessionState | undefined;
  for (const p of prev) {
    s = applyEvent(s, promptEv(p));
    s = applyEvent(s, ev({ contextSize: 30_000, tokens: { input: 10, output: 100, cacheRead: 29_890, cacheWrite: 0, estimated: false } }));
  }
  return s!;
}

function evaluate(threshold: number) {
  const sessions = new Map(data.contexts.map((c) => [c.id, sessionFor(c.prev)]));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const c of data.cases) {
    const prev = sessions.get(c.ctx)!;
    const e = promptEv(c.prompt);
    const fired = !!R4.evaluate({ event: e, prev, state: applyEvent(prev, e), thresholds: { ...R4.defaults, cosine: threshold }, now: 0 });
    if (fired && c.label === 'new') tp++;
    else if (fired) fp++;
    else if (c.label === 'new') fn++;
  }
  return { tp, fp, fn, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn) };
}

describe('R4 sobre el dataset etiquetado (criterio de fase 2)', () => {
  it('100 casos: 50 same / 50 new, 25 contextos', () => {
    expect(data.cases).toHaveLength(100);
    expect(data.cases.filter((c) => c.label === 'new')).toHaveLength(50);
    expect(data.contexts).toHaveLength(25);
  });

  it(`precisión > 80 % con el umbral por defecto (coseno < ${R4_COSINE})`, () => {
    const r = evaluate(R4_COSINE);
    // Se imprime para el informe (docs/reports/fixes-1.md).
    console.log(`R4 @${R4_COSINE}: precisión ${(r.precision * 100).toFixed(1)} % (${r.tp}/${r.tp + r.fp}), recall ${(r.recall * 100).toFixed(1)} %`);
    expect(r.precision).toBeGreaterThan(0.8);
    expect(r.recall).toBeGreaterThan(0.5);
  });

  it('umbral más laxo sube el recall y baja la precisión (monotonía de la curva)', () => {
    const lo = evaluate(0.25);
    const hi = evaluate(0.34);
    expect(hi.recall).toBeGreaterThan(lo.recall);
    expect(hi.precision).toBeLessThan(lo.precision);
  });
});
