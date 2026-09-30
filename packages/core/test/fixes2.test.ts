import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_REARM_MS,
  ClaudeCodeParser,
  DEFAULT_RATE_DAMPING,
  R10,
  evaluateProjection,
  isKnownClaudeCodeVersion,
  projectWindow,
  R7,
  RuleEngine,
  accountSessionId,
  applyEvent,
  defaultConfig,
  effectiveTokens,
  estimateTokens,
  mergeConfig,
  modelTier,
  rawTokens,
  sessionBurn,
  type Config,
  type UsageWindow,
} from '../src/index.js';
import { FIXTURES, ev, fixture } from './helpers.js';

// Defectos de la aceptación ronda 2 (docs/ACCEPTANCE.md §7.6) a nivel core: D-19, D-21, D-22, D-14, D-16, D-5, D-23.

const MIN = 60_000;
const T0 = Date.parse('2026-09-30T12:00:00Z');

/** Plan en % (como plan-usage de Claude Desktop) y serie que lo agota antes del fin de la ventana. */
function percentConfig(): Config {
  return { ...defaultConfig(), plans: [{ provider: 'anthropic', kind: 'subscription', windows: [{ hours: 5, limit: 100 }] }] };
}
function hot(now: number): UsageWindow {
  // 10 % inicial y +8 % cada 15 min durante 90 min: ritmo 32 %/h, 58 % usado → agota en ~1,3 h.
  const pts = [10, 8, 8, 8, 8, 8, 8].map((tokens, i) => ({ ts: now - (6 - i) * 15 * MIN - MIN, tokens }));
  return { provider: 'anthropic', points: pts };
}
function cold(now: number): UsageWindow {
  const pts = [10, 1, 0, 0, 0, 0, 0].map((tokens, i) => ({ ts: now - (6 - i) * 15 * MIN - MIN, tokens }));
  return { provider: 'anthropic', points: pts };
}

describe('D-19: evaluación en seco (replay de arranque) sin efectos', () => {
  it('dryRun informa la R10 pero no fija cooldown ni lugar visible; el primer evento en vivo la publica', () => {
    const eng = new RuleEngine(percentConfig());
    const old = T0 - 20 * MIN;
    const e = ev({ ts: new Date(old).toISOString() });
    const dry = eng.evaluate({ event: e, state: applyEvent(undefined, e), now: old, usageWindow: hot(T0), dryRun: true });
    expect(dry.published.map((s) => s.ruleId)).toContain('R10');
    expect(eng.visibleFor(accountSessionId('anthropic'), old)).toBeUndefined();
    expect(eng.get(dry.published[0]!.id)).toBeUndefined();

    const live = ev({ ts: new Date(T0).toISOString() });
    const out = eng.evaluate({ event: live, state: applyEvent(undefined, live), now: T0, usageWindow: hot(T0) });
    expect(out.published.map((s) => s.ruleId)).toContain('R10');
    expect(out.suppressed.filter((s) => s.ruleId === 'R10')).toEqual([]);
  });

  it('dryRun tampoco fija cooldowns de reglas de sesión (R1)', () => {
    const eng = new RuleEngine();
    const e = ev({ contextSize: 150_000 });
    const dry = eng.evaluate({ event: e, state: applyEvent(undefined, e), now: T0 - 20 * MIN, dryRun: true });
    expect(dry.published.map((s) => s.ruleId)).toEqual(['R1']);
    const out = eng.evaluate({ event: e, state: applyEvent(undefined, e), now: T0 });
    expect(out.published.map((s) => s.ruleId)).toEqual(['R1']);
  });
});

describe('D-22: reglas de cuenta sin eventos de sesión, vigencia = condición', () => {
  it('evaluateAccount publica R10 sin evento; la sugerencia vive lo que su cooldown (60 min), no 10', () => {
    const eng = new RuleEngine(percentConfig());
    const out = eng.evaluateAccount({ provider: 'anthropic', now: T0, usageWindow: hot(T0) });
    expect(out.published).toHaveLength(1);
    const s = out.published[0]!;
    expect(s).toMatchObject({ ruleId: 'R10', sessionId: 'account:anthropic', severity: 'critical' });
    expect(Date.parse(s.expiresAt) - T0).toBe(60 * MIN);
    expect(eng.visibleFor('account:anthropic', T0 + 30 * MIN)?.id).toBe(s.id);
  });

  it('mientras la proyección se cumple se renueva (mismo id); cuando deja de cumplirse se retira', () => {
    const eng = new RuleEngine(percentConfig());
    const first = eng.evaluateAccount({ provider: 'anthropic', now: T0, usageWindow: hot(T0) }).published[0]!;
    // Mismo título y con más de media vida: nada que re-difundir.
    const same = eng.evaluateAccount({ provider: 'anthropic', now: T0 + 1000, usageWindow: hot(T0) });
    expect(same.published).toEqual([]);
    expect(same.refreshed).toEqual([]);
    expect(same.suppressed).toEqual([]);
    // Pasada la mitad de su vida: se renueva con el mismo id y vencimiento nuevo.
    const t1 = T0 + 40 * MIN;
    const r = eng.evaluateAccount({ provider: 'anthropic', now: t1, usageWindow: hot(t1) });
    expect(r.published).toEqual([]);
    expect(r.refreshed.map((s) => s.id)).toEqual([first.id]);
    expect(Date.parse(r.refreshed[0]!.expiresAt)).toBe(t1 + 60 * MIN);
    // Visible a los 90 min de creada (antes: 10 de cada 60 min).
    expect(eng.visibleFor('account:anthropic', T0 + 90 * MIN)?.id).toBe(first.id);
    // La proyección deja de cumplirse → se retira.
    const t2 = T0 + 95 * MIN;
    const c = eng.evaluateAccount({ provider: 'anthropic', now: t2, usageWindow: cold(t2) });
    expect(c.cleared.map((s) => s.id)).toEqual([first.id]);
    expect(eng.visibleFor('account:anthropic', t2)).toBeUndefined();
    // Si vuelve a cumplirse, re-publica a lo sumo tras el margen anti-oscilación (o antes, si el cooldown vence antes).
    const t3 = t2 + 2 * MIN;
    expect(eng.evaluateAccount({ provider: 'anthropic', now: t3, usageWindow: hot(t3) }).suppressed).toEqual([{ ruleId: 'R10', reason: 'cooldown' }]);
    const t4 = t2 + ACCOUNT_REARM_MS + 1;
    const again = eng.evaluateAccount({ provider: 'anthropic', now: t4, usageWindow: hot(t4) });
    expect(again.published.map((s) => s.ruleId)).toEqual(['R10']);
    expect(again.published[0]!.id).not.toBe(first.id);
  });

  it('con R10 vigente, el evento de sesión la renueva en lugar de suprimirla por cooldown', () => {
    const eng = new RuleEngine(percentConfig());
    const first = eng.evaluateAccount({ provider: 'anthropic', now: T0, usageWindow: hot(T0) }).published[0]!;
    const t1 = T0 + 45 * MIN;
    const e = ev({ ts: new Date(t1).toISOString() });
    const out = eng.evaluate({ event: e, state: applyEvent(undefined, e), now: t1, usageWindow: hot(t1) });
    expect(out.suppressed.filter((s) => s.ruleId === 'R10')).toEqual([]);
    expect(out.refreshed?.map((s) => s.id)).toEqual([first.id]);
  });

  it('descartada: no vuelve hasta que pase el cooldown desde la última vez que estuvo vigente', () => {
    const eng = new RuleEngine(percentConfig());
    const first = eng.evaluateAccount({ provider: 'anthropic', now: T0, usageWindow: hot(T0) }).published[0]!;
    const t1 = T0 + 40 * MIN;
    eng.evaluateAccount({ provider: 'anthropic', now: t1, usageWindow: hot(t1) });
    eng.feedback(first.id, 'dismissed', t1 + MIN);
    const t2 = T0 + 70 * MIN;
    expect(eng.evaluateAccount({ provider: 'anthropic', now: t2, usageWindow: hot(t2) }).published).toEqual([]);
    const t3 = t1 + 61 * MIN;
    expect(eng.evaluateAccount({ provider: 'anthropic', now: t3, usageWindow: hot(t3) }).published).toHaveLength(1);
  });

  it('restore (reinicio del daemon): la vigente persistida no se duplica', () => {
    const a = new RuleEngine(percentConfig());
    const s = a.evaluateAccount({ provider: 'anthropic', now: T0, usageWindow: hot(T0) }).published[0]!;
    const b = new RuleEngine(percentConfig());
    b.restore(s, T0 + 5 * MIN);
    const out = b.evaluateAccount({ provider: 'anthropic', now: T0 + 6 * MIN, usageWindow: hot(T0) });
    expect(out.published).toEqual([]);
    expect(b.visibleFor('account:anthropic', T0 + 6 * MIN)?.id).toBe(s.id);
  });

  it('sin plan no evalúa; las de sesión conservan TTL de 10 min', () => {
    const eng = new RuleEngine();
    expect(eng.evaluateAccount({ provider: 'anthropic', now: T0, usageWindow: hot(T0) }).published).toEqual([]);
    const e = ev({ contextSize: 150_000 });
    const s = eng.evaluate({ event: e, state: applyEvent(undefined, e), now: T0 }).published[0]!;
    expect(Date.parse(s.expiresAt) - T0).toBe(10 * MIN);
  });
});

describe('D-21: ritmo en tokens efectivos', () => {
  it('effectiveTokens = input + cacheWrite + output + 0,1 × cacheRead; rawTokens sin ponderar', () => {
    const t = { input: 220, output: 14_019, cacheWrite: 269_406, cacheRead: 27_289_398 };
    expect(effectiveTokens(t)).toBeCloseTo(220 + 14_019 + 269_406 + 2_728_939.8, 5);
    expect(rawTokens(t)).toBe(220 + 14_019 + 269_406 + 27_289_398);
  });

  it('SessionView.burn: tokensPerMin efectivos y rawTokensPerMin crudos (también sidechain)', () => {
    const tokens = { input: 100, output: 100, cacheRead: 129_800, cacheWrite: 0, estimated: false };
    let s = applyEvent(undefined, ev({ ts: new Date(T0).toISOString(), tokens }));
    s = applyEvent(s, ev({ ts: new Date(T0 + MIN).toISOString(), tokens, sidechain: true }));
    const b = sessionBurn(s, T0 + 2 * MIN);
    expect(b.tokensPerMin).toBe(Math.round((2 * 13_180) / 15));
    expect(b.rawTokensPerMin).toBe(Math.round((2 * 130_000) / 15));
  });

  it('muestras persistidas antes de D-21 (sin `raw`) siguen leyéndose', () => {
    const s = applyEvent(undefined, ev({ ts: new Date(T0).toISOString() }));
    s.burnSamples = [{ ts: T0, tokens: 1500 }];
    expect(sessionBurn(s, T0 + MIN)).toMatchObject({ tokensPerMin: 100, rawTokensPerMin: 100 });
  });
});

describe('D-14: nivel de modelo configurable (CP-016.1)', () => {
  it('modelTier: id exacto, fragmento más largo, tabla', () => {
    const o = { 'claude-opus-5-5': 'mid' as const, opus: 'small' as const, 'mi-modelo-interno': 'top' as const };
    expect(modelTier('claude-opus-5-5', 'anthropic', o)).toBe('mid');
    expect(modelTier('claude-opus-4-1', 'anthropic', o)).toBe('small');
    expect(modelTier('Mi-Modelo-Interno-v2', 'anthropic', o)).toBe('top');
    expect(modelTier('claude-sonnet-4-5', 'anthropic', o)).toBe('mid');
    expect(modelTier('claude-opus-4-1', 'anthropic')).toBe('top');
  });

  it('R7 respeta `modelTiers` de la config (aditivo: sin override, igual que antes)', () => {
    const simple = ev({ model: 'mi-modelo-interno', promptTokens: 50, tokens: { input: 50, output: 100, estimated: false }, contextSize: 2000 });
    const state = applyEvent(undefined, simple);
    const fire = (cfg: Config) => new RuleEngine(cfg).evaluate({ event: simple, state, now: T0 }).published.map((s) => s.ruleId);
    expect(fire(defaultConfig())).not.toContain('R7');
    expect(fire(mergeConfig(defaultConfig(), { modelTiers: { 'mi-modelo-interno': 'top' } }))).toContain('R7');
    const opus = { ...simple, model: 'claude-opus-4-1' };
    const e2 = new RuleEngine(mergeConfig(defaultConfig(), { modelTiers: { opus: 'mid' } }));
    expect(e2.evaluate({ event: opus, state: applyEvent(undefined, opus), now: T0 }).published.map((s) => s.ruleId)).not.toContain('R7');
    expect(R7.id).toBe('R7');
  });
});

describe('D-16: formato desconocido en transcripts de Claude Code (CP-027.3, CP-030.5)', () => {
  const line = (o: object) => JSON.stringify({ sessionId: 's', timestamp: '2026-09-30T10:00:00.000Z', ...o });
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 };
  const asst = (version: string, message: object) => line({ type: 'assistant', version, message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [], ...message } });

  it('versiones conocidas (1.x, 2.x) emiten; versión de otro mayor no emite cifras y deja detalle', () => {
    expect(isKnownClaudeCodeVersion('2.1.285')).toBe(true);
    expect(isKnownClaudeCodeVersion('1.0.99')).toBe(true);
    expect(isKnownClaudeCodeVersion('3.0.0')).toBe(false);
    expect(isKnownClaudeCodeVersion('beta')).toBe(false);
    const p = new ClaudeCodeParser();
    expect(p.feed(asst('2.1.284', { id: 'm1', usage }))).toHaveLength(1);
    expect(p.formatErrors).toBe(0);
    expect(p.feed(asst('3.0.1', { id: 'm2', usage }))).toEqual([]);
    expect(p.formatErrors).toBe(1);
    expect(p.formatIssue).toMatch(/versión de formato desconocida: 3\.0\.1/);
  });

  it('llamada sin message.usage o con cifras no numéricas → sin evento, error de formato', () => {
    const p = new ClaudeCodeParser();
    expect(p.feed(asst('2.1.284', { id: 'm1' }))).toEqual([]);
    expect(p.feed(asst('2.1.284', { id: 'm2', usage: { input_tokens: '10', output_tokens: 20 } }))).toEqual([]);
    expect(p.feed(asst('2.1.284', { usage }))).toEqual([]);
    expect(p.formatErrors).toBe(3);
    expect(p.formatIssue).toMatch(/message\.usage/);
    // <synthetic> (errores de API) sigue ignorándose sin error; JSON inválido sigue en `errors`.
    expect(p.feed(asst('2.1.284', { id: 'm3', model: '<synthetic>' }))).toEqual([]);
    p.feed('{no json');
    expect(p.formatErrors).toBe(3);
    expect(p.errors).toBe(1);
  });

  it('el fixture real sanitizado no tiene errores de formato', () => {
    const p = new ClaudeCodeParser();
    const dir = 'claude-code';
    const file = readdirSync(join(FIXTURES, dir)).find((f) => f.endsWith('.jsonl'))!;
    for (const l of fixture(`${dir}/${file}`).split('\n')) p.feed(l);
    expect(p.formatErrors).toBe(0);
  });
});

describe('D-5: proyección amortiguada (R10 rateDamping)', () => {
  it('R10 usa ritmo × rateDamping; el detalle muestra el ritmo medido y el proyectado', () => {
    expect(R10.defaults.rateDamping).toBe(DEFAULT_RATE_DAMPING);
    const spec = { key: '5h', label: '5 h', ms: 5 * 3_600_000, budget: 100 };
    const pts = hot(T0).points;
    const raw = projectWindow(pts, spec, T0, 60 * MIN)!;
    const damped = projectWindow(pts, spec, T0, 60 * MIN, 0.6)!;
    expect(damped.perHour).toBeCloseTo(raw.perHour, 9);
    expect(damped.projectedPerHour).toBeCloseTo(raw.perHour * 0.6, 9);
    expect(damped.exhaustAt! - T0).toBeCloseTo((raw.exhaustAt! - T0) / 0.6, 0);
    const eng = new RuleEngine(percentConfig());
    const s = eng.evaluateAccount({ provider: 'anthropic', now: T0, usageWindow: hot(T0) }).published[0]!;
    expect(s.detail).toMatch(/ritmo de los últimos 60 min: 32 %\/h \(se proyecta con 19 %\/h/);
  });

  it('evaluateProjection: método damp y partición ajuste/validación', () => {
    const t0 = T0;
    // Dos ventanas sintéticas con ráfaga inicial y uso plano después.
    // (La última ventana de la serie no cuenta como completa: se agrega una tercera sin cerrar.)
    const samples = [0, 1, 2].flatMap((k) => {
      const start = t0 + k * 6 * 3_600_000;
      const pct = [5, 15, 25, 35, 40, 44, 46, 47, 48];
      return [0, 15, 30, 45, 60, 120, 180, 240, 299].map((m, i) => ({ t: start + m * MIN, pct: pct[i]! }));
    });
    const raw = evaluateProjection(samples, { method: 'recent:60' });
    const damp = evaluateProjection(samples, { method: 'damp:0.6:60' });
    expect(raw.windows).toBe(2);
    expect(damp.meanError).toBeLessThan(raw.meanError);
    expect(evaluateProjection(samples, { method: 'damp:0.6:60', windowFilter: (i) => i === 0 }).windows).toBe(1);
  });
});

describe('D-23: estimador con URLs y hashes', () => {
  it('URLs y corridas alfanuméricas largas se cobran por longitud (~3 caracteres por token × factor)', () => {
    const hash = 'a3f9c2e17b4d8e0f5a6c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f'; // 64 hex
    expect(estimateTokens(hash)).toBe(Math.round((64 / 3) * 1.3));
    const url = 'https://assets-proxy.example.com/claude-ai/v2/assets/v1/index-s_FRnRss.js';
    expect(estimateTokens(url)).toBe(Math.round((url.length / 3) * 1.3));
    // Listado de URLs: la parte de URLs se cobra por longitud; el resto (">>", "@ 1000") por palabra.
    const list = Array.from({ length: 50 }, (_, i) => `>> https://cdn.example.com/a/b${i}/file-${i}x9Qz.js @ ${1000 + i}`).join('\n');
    const urls = list.split('\n').reduce((a, l) => a + l.split(' ')[1]!.length, 0);
    const rest = list.replace(/https:\/\/\S+/g, ' ');
    expect(Math.abs(estimateTokens(list) - Math.round(urls / 3 * 1.3 + estimateTokens(rest)))).toBeLessThanOrEqual(1);
  });

  it('texto sin URLs ni corridas mixtas no cambia (palabras largas sin dígitos siguen por palabra)', () => {
    const prose = 'La sesión usa demasiado contexto; compactá con un foco en los archivos editados recientemente.';
    const hash = 'a3f9c2e17b4d8e0f5a6c1b2d3e4f5a6b';
    // Aditivo: el hash no altera el conteo del texto que lo rodea (salvo redondeo).
    expect(Math.abs(estimateTokens(`${prose} ${hash}`) - estimateTokens(prose) - estimateTokens(hash))).toBeLessThanOrEqual(1);
    expect(estimateTokens('internacionalizacionextraordinaria')).toBe(Math.round(Math.ceil(34 / 4.2) * 1.3));
  });
});
