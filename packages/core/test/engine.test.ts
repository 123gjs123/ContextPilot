import { describe, expect, it } from 'vitest';
import { ALL_RULES, RuleEngine, applyEvent, defaultConfig, mergeConfig, validateSuggestion, type Rule, type Severity, type SessionState, type TurnEvent } from '../src/index.js';
import { ev, run } from './helpers.js';

const MIN = 60_000;
const T0 = Date.parse('2026-09-29T10:00:00Z');

/** Regla de prueba que dispara siempre con la severidad/ahorro dados. */
function fake(id: string, severity: Severity, saving = 0, extra: Partial<Rule> = {}): Rule {
  return {
    id,
    phase: 0,
    sources: ['claude-code', 'web'],
    requiresExact: false,
    defaults: { x: 1 },
    defaultCooldownMs: 20 * MIN,
    on: ['response'],
    evaluate: ({ thresholds }) =>
      thresholds.x === 0
        ? null
        : { severity, title: id, detail: 'd', estimatedSavingTokens: saving, actions: [{ kind: 'show-detail', label: 'ver' }] },
    ...extra,
  };
}

function engineWith(rules: Rule[]) {
  return new RuleEngine(defaultConfig(rules), rules);
}

function fire(eng: RuleEngine, now: number, over: Partial<TurnEvent> = {}, sessionId = 'S1') {
  const e = ev({ sessionId, ...over });
  const state = applyEvent(undefined, e);
  return eng.evaluate({ event: e, state, now });
}

describe('RuleEngine: sources y requiresExact (CP-008)', () => {
  it('fuente no declarada no se evalúa', () => {
    const eng = engineWith([fake('A', 'warn')]);
    expect(fire(eng, T0, { source: 'codex' }).published).toHaveLength(0);
  });
  it('requiresExact con evento estimado no dispara', () => {
    const eng = engineWith([fake('A', 'warn', 0, { requiresExact: true })]);
    expect(fire(eng, T0, { tokens: { input: 1, output: 1, estimated: true } }).published).toHaveLength(0);
    expect(fire(eng, T0, { tokens: { input: 1, output: 1, estimated: false } }).published).toHaveLength(1);
  });
  it('override por proveedor pisa el default; otro proveedor usa el default', () => {
    const cfg = mergeConfig(defaultConfig([fake('A', 'warn')]), { providerOverrides: { anthropic: { A: { x: 0 } } } });
    const eng = new RuleEngine(cfg, [fake('A', 'warn')]);
    expect(fire(eng, T0).published).toHaveLength(0);
    expect(fire(eng, T0, { provider: 'openai' }).published).toHaveLength(1);
    expect(eng.thresholdsFor(fake('A', 'warn'), 'anthropic').x).toBe(0);
  });
  it('regla deshabilitada nunca emite', () => {
    const cfg = mergeConfig(defaultConfig([fake('A', 'warn')]), { rules: { A: { enabled: false } as any } });
    expect(fire(new RuleEngine(cfg, [fake('A', 'warn')]), T0).published).toHaveLength(0);
  });
  it('R1 con override anthropic 0.55 dispara a 0,56', () => {
    const cfg = mergeConfig(defaultConfig(), { providerOverrides: { anthropic: { R1: { pct: 0.55 } } } });
    const eng = new RuleEngine(cfg);
    const e = ev({ contextSize: 112_000, tokens: { input: 10, output: 10, cacheRead: 111_000, estimated: false } });
    expect(eng.evaluate({ event: e, state: applyEvent(undefined, e), now: T0 }).published.map((s) => s.ruleId)).toContain('R1');
  });
});

describe('RuleEngine: cooldown, una visible, agrupación (CP-009)', () => {
  it('cooldown 20 min por regla y sesión', () => {
    const eng = engineWith([fake('A', 'warn')]);
    const s = fire(eng, T0).published[0]!;
    eng.feedback(s.id, 'dismissed', T0);
    expect(fire(eng, T0 + 19 * MIN).suppressed).toEqual([{ ruleId: 'A', reason: 'cooldown' }]);
    expect(fire(eng, T0 + 21 * MIN).published).toHaveLength(1);
    // Otra sesión no comparte cooldown
    expect(fire(eng, T0 + MIN, {}, 'S2').published).toHaveLength(1);
  });

  it('dos reglas simultáneas → una visible (mayor severidad), la otra agrupada', () => {
    const eng = engineWith([fake('LOW', 'info', 999_999), fake('HIGH', 'critical', 1)]);
    const out = fire(eng, T0);
    expect(out.published).toHaveLength(1);
    expect(out.published[0]!.ruleId).toBe('HIGH');
    expect(out.published[0]!.grouped).toEqual([{ ruleId: 'LOW', title: 'LOW' }]);
    expect(out.suppressed).toEqual([{ ruleId: 'LOW', reason: 'grouped' }]);
  });

  it('empate de severidad → mayor ahorro estimado', () => {
    const eng = engineWith([fake('A', 'warn', 100), fake('B', 'warn', 5000)]);
    expect(fire(eng, T0).published[0]!.ruleId).toBe('B');
  });

  it('sugerencia vigente: menor severidad no la reemplaza, mayor sí', () => {
    const rules = [fake('W', 'warn'), fake('I', 'info', 0, { defaultCooldownMs: 0 }), fake('C', 'critical')];
    const eng = engineWith(rules);
    const only = (id: string) => {
      const cfg = defaultConfig(rules);
      for (const r of rules) cfg.rules[r.id]!.enabled = r.id === id;
      eng.setConfig(cfg);
    };
    only('W');
    const w = fire(eng, T0).published[0]!;
    only('I');
    const out = fire(eng, T0 + MIN);
    expect(out.published).toHaveLength(0);
    expect(out.suppressed).toEqual([{ ruleId: 'I', reason: 'visible' }]);
    expect(eng.visibleFor('S1', T0 + MIN)?.id).toBe(w.id);
    only('C');
    const c = fire(eng, T0 + 2 * MIN).published[0]!;
    expect(eng.visibleFor('S1', T0 + 2 * MIN)?.id).toBe(c.id);
  });

  it('snoozed silencia la regla 15 min en esa sesión', () => {
    const eng = engineWith([fake('A', 'warn', 0, { defaultCooldownMs: 0 })]);
    const s = fire(eng, T0).published[0]!;
    eng.feedback(s.id, 'snoozed', T0);
    expect(fire(eng, T0 + 14 * MIN).published).toHaveLength(0);
    expect(fire(eng, T0 + 15 * MIN + 1).published).toHaveLength(1);
  });

  it('toda sugerencia publicada pasa validateSuggestion (≥ 1 acción)', () => {
    const eng = engineWith([fake('A', 'warn')]);
    const s = fire(eng, T0).published[0]!;
    expect(validateSuggestion(s).ok).toBe(true);
    expect(validateSuggestion({ ...s, actions: [] }).ok).toBe(false);
  });
});

describe('RuleEngine: feedback ajusta prioridad (CP-014)', () => {
  it('3 descartes → severidad −1 y cooldown ×2; accepted resetea', () => {
    const eng = engineWith([fake('A', 'critical')]);
    let now = T0;
    for (let i = 0; i < 3; i++) {
      const s = fire(eng, now).published[0]!;
      expect(s.severity).toBe('critical');
      eng.feedback(s.id, 'dismissed', now);
      now += 21 * MIN;
    }
    const demoted = fire(eng, now).published[0]!;
    expect(demoted.severity).toBe('warn');
    eng.feedback(demoted.id, 'accepted', now);
    // Cooldown duplicado (40 min): a los 21 min sigue silenciada
    expect(fire(eng, now + 21 * MIN).published).toHaveLength(0);
    const back = fire(eng, now + 41 * MIN).published[0]!;
    expect(back.severity).toBe('critical');
    expect(eng.getDismissStreaks().A).toBe(0);
  });

  it('info + 3 descartes más → quiet (sólo side panel/dashboard), nunca se deshabilita', () => {
    const eng = engineWith([fake('A', 'warn', 0, { defaultCooldownMs: 0 })]);
    let now = T0;
    const sev: (Severity | string)[] = [];
    for (let i = 0; i < 9; i++) {
      const s = fire(eng, now).published[0]!;
      sev.push(s.quiet ? 'quiet' : s.severity);
      eng.feedback(s.id, 'dismissed', now);
      now += MIN;
    }
    expect(sev).toEqual(['warn', 'warn', 'warn', 'info', 'info', 'info', 'quiet', 'quiet', 'quiet']);
    expect(fire(eng, now).published).toHaveLength(1);
  });

  it('rachas persistibles (load/get)', () => {
    const eng = engineWith([fake('A', 'critical')]);
    eng.loadDismissStreaks({ A: 3 });
    expect(fire(eng, T0).published[0]!.severity).toBe('warn');
  });
});

describe('RuleEngine: sidechain y ahorro', () => {
  it('evento sidechain sólo evalúa R5/R8/R10', () => {
    const eng = new RuleEngine();
    let st: SessionState | undefined = run([ev({ contextSize: 150_000, tokens: { input: 10, output: 10, cacheRead: 149_000, estimated: false } })]).state;
    const side = ev({ sidechain: true, model: 'claude-opus-4-1', promptTokens: 10, tokens: { input: 10, output: 10, estimated: false }, toolCalls: [{ name: 'Read', resultTokens: 50_000, failed: false, argsHash: 'a' }] });
    const prev = st;
    st = applyEvent(prev, side);
    const out = eng.evaluate({ event: side, prev, state: st, now: T0 });
    expect([...out.published.map((s) => s.ruleId), ...out.suppressed.map((s) => s.ruleId)]).toEqual(['R5']);
  });

  it('estimatedSavingTokens sale de la fórmula de savings.ts', () => {
    const eng = new RuleEngine();
    const e = ev({ toolCalls: [{ name: 'Read', resultTokens: 20_000, failed: false, argsHash: 'a' }] });
    const s = eng.evaluate({ event: e, state: applyEvent(undefined, e), now: T0 }).published[0]!;
    expect(s.ruleId).toBe('R5');
    expect(s.estimatedSavingTokens).toBe(Math.round(20_000 * 0.8 * 10));
  });

  it('rendimiento: 17 reglas sobre 1000 eventos, p99 < 20 ms', () => {
    const eng = new RuleEngine();
    let st: SessionState | undefined;
    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const e = ev({ turn: i + 1, contextSize: 1000 + i * 100, tokens: { input: 100, output: 50, cacheRead: 900 + i * 100, estimated: false } });
      const prev = st;
      st = applyEvent(prev, e);
      const t = performance.now();
      eng.evaluate({ event: e, prev, state: st, now: T0 + i * 1000 });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[989]!).toBeLessThan(20);
    expect(ALL_RULES).toHaveLength(17);
  });
});
