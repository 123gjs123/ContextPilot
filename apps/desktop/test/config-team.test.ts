import { defaultConfig } from '@contextpilot/core';
import { describe, expect, it } from 'vitest';
import { configToForm, diffConfig, formToConfig, looksLikeConfig, PLAN_PRESETS } from '../src/shared/configForm.js';
import { mergeTeam, parseTeamFile, privacyWarnings } from '../src/shared/team.js';

describe('Config ↔ formulario (CP-054/055/056)', () => {
  it('round-trip sin cambios devuelve la misma config', () => {
    const c = defaultConfig();
    c.plans = [{ provider: 'anthropic', kind: 'subscription', windowMs: 5 * 3_600_000, windowBudgetTokens: 2_000_000 }];
    c.adapters = { codex: { enabled: false } };
    const { patch, errors } = formToConfig(configToForm(c));
    expect(errors).toEqual({});
    expect(patch.rules).toEqual(c.rules);
    expect(patch.plans).toEqual(c.plans);
    expect(patch.adapters!.codex).toEqual({ enabled: false });
    expect(patch.adapters!['claude-code']).toEqual({ enabled: true });
  });

  it('reglas ordenadas R1..R10, W*, G*', () => {
    const ids = configToForm(defaultConfig()).rules.map((r) => r.id);
    expect(ids.indexOf('R2')).toBeLessThan(ids.indexOf('R10'));
    expect(ids.indexOf('R10')).toBeLessThan(ids.indexOf('W1'));
    expect(ids.indexOf('W4')).toBeLessThan(ids.indexOf('G1'));
  });

  it('edita umbrales, cooldown y desactiva reglas', () => {
    const f = configToForm(defaultConfig());
    const r1 = f.rules.find((r) => r.id === 'R1')!;
    r1.enabled = false;
    r1.cooldownMin = 5;
    r1.thresholds[0]!.value = 0.7;
    const { patch } = formToConfig(f);
    expect(patch.rules!.R1!.enabled).toBe(false);
    expect(patch.rules!.R1!.cooldownMs).toBe(300_000);
    expect(patch.rules!.R1!.thresholds[r1.thresholds[0]!.key]).toBe(0.7);
  });

  it('perfil API y suscripción (CP-055.1) con validación', () => {
    const f = configToForm(defaultConfig());
    const a = f.plans.find((p) => p.provider === 'openai')!;
    Object.assign(a, { kind: 'api', dailyBudgetUsd: 5, pricePerMTokIn: 1.25, pricePerMTokOut: 10 });
    const g = f.plans.find((p) => p.provider === 'google')!;
    Object.assign(g, { kind: 'subscription', windowHours: null, windowBudgetTokens: -1 });
    const { patch, errors } = formToConfig(f);
    expect(patch.plans).toContainEqual({ provider: 'openai', kind: 'api', dailyBudgetUsd: 5, pricePerMTokIn: 1.25, pricePerMTokOut: 10 });
    expect(errors['plans.google.windowHours']).toBeDefined();
    expect(errors['plans.google.windowBudgetTokens']).toBeDefined();
  });

  it('umbral negativo es error', () => {
    const f = configToForm(defaultConfig());
    f.rules[0]!.thresholds[0]!.value = -1;
    expect(Object.keys(formToConfig(f).errors)).toHaveLength(1);
  });

  it('presets de suscripción marcados «a calibrar»', () => {
    expect(PLAN_PRESETS.filter((p) => p.plan.kind === 'subscription').every((p) => p.calibrate)).toBe(true);
    expect(new Set(PLAN_PRESETS.map((p) => p.plan.provider))).toEqual(new Set(['anthropic', 'openai', 'google']));
  });

  it('diff para importar (CP-056.2)', () => {
    const a = defaultConfig();
    const b = structuredClone(a);
    b.rules.R1!.enabled = false;
    b.plans = [{ provider: 'google', kind: 'api', dailyBudgetUsd: 1 }];
    const d = diffConfig(a, b);
    expect(d.map((x) => x.path).sort()).toEqual(['plans', 'rules.R1.enabled']);
    expect(diffConfig(a, structuredClone(a))).toEqual([]);
  });

  it('looksLikeConfig', () => {
    expect(looksLikeConfig({ rules: {} })).toBe(true);
    expect(looksLikeConfig({ schemaVersion: 1, config: { plans: [] } })).toBe(true);
    expect(looksLikeConfig([])).toBe(false);
    expect(looksLikeConfig({ foo: 1 })).toBe(false);
  });
});

describe('modo equipo (CP-057.3)', () => {
  const f1 = JSON.stringify({
    week: '2026-W39',
    rows: [
      { provider: 'anthropic', sessions: 10, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 9000 },
      { ruleId: 'R1', suggestions: 8, accepted: 4, savedTokens: 50_000 },
    ],
  });
  const f2 = JSON.stringify({
    period: { from: '2026-09-22T00:00:00Z' },
    byProvider: [{ provider: 'anthropic', sessions: 6, input: 500, output: 100, cacheRead: 500, savedTokens: 1 }],
    byRule: [{ ruleId: 'R1', fired: 2, accepted: 2, savedTokens: 10_000 }, { ruleId: 'W1', fired: 5, accepted: 0, savedTokens: 0 }],
  });

  it('combina N archivos sumando por proveedor y regla', () => {
    const agg = mergeTeam([parseTeamFile('a.json', f1), parseTeamFile('b.json', f2)]);
    expect(agg.totals.sessions).toBe(16);
    expect(agg.totals.suggestions).toBe(15);
    expect(agg.totals.acceptanceText).toBe('40%');
    expect(agg.totals.savedText).toBe('≈60k');
    const r1 = agg.byRule.find((r) => r.ruleId === 'R1')!;
    expect(r1.suggestions).toBe(10);
    expect(r1.acceptanceText).toBe('60%');
    expect(agg.byProvider[0]).toMatchObject({ provider: 'anthropic', sessions: 16 });
    expect(agg.weeks).toEqual(['2026-09-22', '2026-W39']);
  });

  it('avisa datos identificables y JSON inválido', () => {
    expect(privacyWarnings('{"sessionId":"x"}')).toContain('contiene sessionId');
    expect(privacyWarnings('{"h":"deadbeefdeadbeef00"}')[0]).toMatch(/hex/);
    expect(privacyWarnings('{"p":"C:\\\\Users\\\\x"}')).toContain('contiene rutas de archivos');
    expect(privacyWarnings(f1)).toEqual([]);
    expect(parseTeamFile('x', '{').warnings).toEqual(['JSON inválido']);
    expect(parseTeamFile('x', '{}').warnings).toContain('sin filas agregadas');
  });
});
