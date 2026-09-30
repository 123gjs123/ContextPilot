import { describe, expect, it } from 'vitest';
import {
  R10,
  applyEvent,
  evaluateProjection,
  planWindows,
  projectWindow,
  sessionBurn,
  splitWindows,
  toView,
  type PctSample,
} from '../src/index.js';
import { ev, fixture } from './helpers.js';

// D-5 / CP-018: ritmo expuesto, proyección y medición de error por replay de 5 h.

const MIN = 60_000;
const H = 60 * MIN;

function pctSamples(): PctSample[] {
  const j = JSON.parse(fixture('plan-usage/replay-5h.json'));
  return j.samples.map((s: any) => ({ t: s.t, pct: s.u.fh }));
}

describe('planWindows', () => {
  it('formato nuevo (5 h + 7 días) y formato viejo', () => {
    expect(planWindows({ provider: 'anthropic', kind: 'subscription', windows: [{ hours: 5, limit: 100 }, { days: 7, limit: 100 }] }).map((w) => w.key)).toEqual(['5h', '168h']);
    expect(planWindows({ provider: 'anthropic', kind: 'subscription', windowMs: 5 * H, windowBudgetTokens: 10 }).map((w) => w.label)).toEqual(['5 h']);
    expect(planWindows({ provider: 'anthropic', kind: 'api', dailyBudgetUsd: 1, pricePerMTokIn: 1 })).toEqual([]);
  });
});

describe('SessionView.burn (CP-018.1)', () => {
  it('tokens/min con media móvil de 15 min', () => {
    const t0 = Date.parse('2026-09-29T10:00:00Z');
    let s = applyEvent(undefined, ev({ ts: new Date(t0).toISOString(), tokens: { input: 1000, output: 500, estimated: false } }));
    s = applyEvent(s, ev({ ts: new Date(t0 + 5 * MIN).toISOString(), tokens: { input: 1000, output: 500, estimated: false } }));
    // Muestra vieja (fuera de 15 min) no cuenta.
    expect(sessionBurn(s, t0 + 10 * MIN).tokensPerMin).toBe(200);
    expect(sessionBurn(s, t0 + 17 * MIN).tokensPerMin).toBe(100);
    expect(toView(s, t0 + 10 * MIN).burn).toMatchObject({ tokensPerMin: 200, tokensPerHour: 12_000, windowMin: 15 });
  });
});

describe('proyección con agotamiento conocido (CP-018.3 literal)', () => {
  it('ventana 1 del fixture se agota a ~4 h: a 1 h, 2 h y 3 h el error |T̂ − T| / 5 h < 20 %', () => {
    const samples = pctSamples();
    const w = splitWindows(samples, 5 * H)[0]!;
    const T = w.samples.find((s) => s.pct >= 100)!.t;
    const spec = { key: '5h', label: '5 h', ms: 5 * H, budget: 100 };
    for (const h of [1, 2, 3]) {
      const now = w.start + h * H;
      const seen = w.samples.filter((s) => s.t <= now);
      const points = seen.map((s, i) => ({ ts: s.t, tokens: i === 0 ? s.pct : s.pct - seen[i - 1]!.pct }));
      const p = projectWindow(points, spec, now, R10.defaults.rateWindowMin! * MIN);
      expect(p?.exhaustAt, `checkpoint ${h} h`).toBeDefined();
      expect(Math.abs(p!.exhaustAt! - T) / (5 * H), `checkpoint ${h} h`).toBeLessThan(0.2);
    }
  });
});

describe('evaluateProjection sobre el fixture (% al final de la ventana)', () => {
  it('3 ventanas completas; error medio < 20 % con el ritmo de 30 min', () => {
    const r = evaluateProjection(pctSamples(), { method: 'recent:30' });
    expect(r.windows).toBe(3);
    expect(r.cases).toHaveLength(9);
    expect(r.meanError).toBeLessThan(0.2);
  });
  it('el ritmo reciente (el de R10) no es peor que la media desde el inicio en el fixture', () => {
    const recent = evaluateProjection(pctSamples(), { method: `recent:${R10.defaults.rateWindowMin}` });
    const mean = evaluateProjection(pctSamples(), { method: 'mean' });
    expect(recent.meanError).toBeLessThanOrEqual(mean.meanError);
    expect(recent.maxError).toBeLessThan(0.2);
  });
  it('ventana incompleta (sin muestra cerca del final) no cuenta', () => {
    const s = pctSamples().filter((x) => x.t < pctSamples()[0]!.t + 2 * H);
    expect(evaluateProjection(s).windows).toBe(0);
  });
});
