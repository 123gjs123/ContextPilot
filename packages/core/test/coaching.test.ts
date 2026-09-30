import { describe, expect, it } from 'vitest';
import {
  ALL_RULES,
  cacheCountdown,
  coachingFor,
  formatThreshold,
  recommendedSettings,
  ruleDocFor,
  ruleDocs,
  ruleName,
  thresholdLabel,
  tipFor,
  tipsFor,
  TIP_ROTATE_MS,
  type SessionView,
} from '../src/index.js';

// CP-060 (coaching) y CP-063 (documentación de reglas): puros, exactos respecto del código.

const NOW = Date.parse('2026-09-30T12:00:00Z');
const MIN = 60_000;

function view(p: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1',
    source: 'claude-code',
    provider: 'anthropic',
    client: 'cli',
    model: 'claude-sonnet-4-5',
    turns: 5,
    contextSize: 60_000,
    contextWindow: 200_000,
    contextPct: 0.3,
    cachePct: 0.9,
    estimated: false,
    lastTurnAt: new Date(NOW - 10_000).toISOString(),
    status: 'active',
    cacheTtlMs: 5 * MIN,
    ...p,
  };
}

describe('coachingFor (CP-060)', () => {
  it('toda regla del motor tiene qué/por qué/qué hacer/hábito no vacíos', () => {
    for (const r of ALL_RULES) {
      const c = coachingFor(r.id, { view: view(), suggestion: { title: 'T', detail: 'D' }, now: NOW });
      expect(c.what, r.id).toBeTruthy();
      expect(c.why, r.id).toBeTruthy();
      expect(c.action, r.id).toBeTruthy();
      expect(c.habit, r.id).toBeTruthy();
    }
  });
  it('usa los números de la sesión', () => {
    const c = coachingFor('R1', { view: view({ contextSize: 144_000, contextPct: 0.72 }), now: NOW });
    expect(c.what).toBe('El contexto está al 72% (144k de 200k tokens).');
    expect(c.habit).toContain('60%');
    const r2 = coachingFor('R2', { view: view({ lastTurnAt: new Date(NOW - 7 * MIN).toISOString(), contextSize: 90_000 }), now: NOW });
    expect(r2.what).toContain('Pasaron 7 min');
    expect(r2.what).toContain('TTL 5 min');
    expect(r2.what).toContain('90k');
    expect(coachingFor('W1', { view: view({ source: 'web', turns: 41, contextSize: 85_000, estimated: true }) }).what).toContain('41 mensajes');
  });
  it('estimado → «≈»; regla desconocida → título de la sugerencia', () => {
    expect(coachingFor('R4', { view: view({ estimated: true }) }).what).toContain('≈60k');
    const c = coachingFor('X9', { suggestion: { title: 'Algo raro', detail: 'porque sí' } });
    expect(c.what).toBe('Algo raro.');
    expect(c.why).toBe('porque sí');
  });
});

describe('tipFor / tipsFor (CP-060)', () => {
  it('cuenta regresiva de caché (fuente con TTL real, contexto > 50k, pausa ≥ 1 min)', () => {
    const v = view({ lastTurnAt: new Date(NOW - 3 * MIN).toISOString() });
    expect(cacheCountdown(v, NOW)?.remainingMs).toBe(2 * MIN);
    expect(tipFor(v, NOW)).toMatch(/^Caché expira en 2 min \(TTL 5 min\)/);
    // TTL de 1 h
    expect(tipFor(view({ cacheTtlMs: 60 * MIN, lastTurnAt: new Date(NOW - 48 * MIN).toISOString() }), NOW)).toMatch(/expira en 12 min \(TTL 1 h\)/);
    // TTL de 1 h con 1 min de pausa: todavía no (sería ruido mientras trabajás)
    expect(tipsFor(view({ cacheTtlMs: 60 * MIN, lastTurnAt: new Date(NOW - 2 * MIN).toISOString() }), NOW).some((t) => t.kind === 'cache-countdown')).toBe(false);
  });
  it('caché vencida, contexto chico, web o estimado: sin cuenta regresiva', () => {
    expect(tipFor(view({ lastTurnAt: new Date(NOW - 8 * MIN).toISOString() }), NOW)).toMatch(/La caché expiró hace 3 min/);
    expect(cacheCountdown(view({ contextSize: 40_000 }), NOW)).toBeNull();
    expect(cacheCountdown(view({ source: 'web' }), NOW)).toBeNull();
    expect(cacheCountdown(view({ estimated: true }), NOW)).toBeNull();
  });
  it('contexto 45 % → «cuando pase 60 % conviene /compact con foco»; > 60 % urgente', () => {
    const rising = tipsFor(view({ contextPct: 0.45, contextSize: 30_000 }), NOW);
    expect(rising[0]!.kind).toBe('context-rising');
    expect(rising[0]!.text).toContain('Cuando pase 60% conviene /compact con foco');
    const high = view({ contextPct: 0.7, contextSize: 140_000 });
    expect(tipFor(high, NOW)).toMatch(/^Contexto al 70%/);
    // Umbral configurado
    expect(tipsFor(view({ contextPct: 0.55, contextSize: 30_000 }), NOW, { r1Pct: 0.7 })[0]!.text).toContain('Cuando pase 70%');
    // Gemini CLI: /compress
    expect(tipsFor(view({ source: 'gemini-cli', provider: 'google', contextPct: 0.5, contextSize: 30_000 }), NOW)[0]!.text).toContain('/compress');
  });
  it('caché baja y modelo top con contexto chico', () => {
    const kinds = tipsFor(view({ cachePct: 0.2, contextSize: 20_000, model: 'claude-opus-4-5' }), NOW).map((t) => t.kind);
    expect(kinds).toContain('cache-low');
    expect(kinds).toContain('model');
  });
  it('rota entre los no urgentes cada TIP_ROTATE_MS; sin ventana → null', () => {
    const v = view({ contextSize: 20_000 });
    const all = tipsFor(v, NOW).map((t) => t.text);
    const seen = new Set([0, 1, 2, 3].map((i) => tipFor(v, i * TIP_ROTATE_MS)));
    expect(seen.size).toBe(Math.min(4, all.length));
    for (const s of seen) expect(all).toContain(s);
    expect(tipFor(view({ contextWindow: 0 }), NOW)).toBeNull();
    expect(tipFor(undefined, NOW)).toBeNull();
  });
  it('web: conversación larga y hábito de Projects', () => {
    const t = tipsFor(view({ source: 'web', client: 'claude.ai', contextSize: 60_000, estimated: true }), NOW);
    expect(t.map((x) => x.kind)).toEqual(['chat-long', 'habit']);
  });
});

describe('ruleDocs (CP-063)', () => {
  it('documenta todas las reglas con valores recomendados = defaults de la regla', () => {
    const docs = ruleDocs();
    expect(docs.map((d) => d.id)).toEqual(ALL_RULES.map((r) => r.id));
    for (const r of ALL_RULES) {
      const d = ruleDocFor(r.id)!;
      expect(d.name).not.toBe(r.id);
      for (const k of ['detects', 'why', 'suggests', 'cooldownWhy', 'sourcesText'] as const) expect(d[k], `${r.id}.${k}`).toBeTruthy();
      expect(d.cooldownMin).toBe(r.defaultCooldownMs / 60_000);
      expect(Object.fromEntries(d.thresholds.map((t) => [t.key, t.value]))).toEqual(r.defaults);
      for (const t of d.thresholds) {
        expect(t.label, `${r.id}.${t.key}`).not.toBe(t.key);
        expect(t.why, `${r.id}.${t.key}`).toBeTruthy();
      }
      expect(recommendedSettings(r.id)).toEqual({ thresholds: r.defaults, cooldownMin: r.defaultCooldownMs / 60_000 });
    }
  });
  it('formatos y datos puntuales', () => {
    expect(ruleDocFor('R1')!.thresholds[0]!.valueText).toBe('60 %');
    expect(ruleDocFor('R2')!.thresholds[0]!.valueText).toBe('50k tokens');
    expect(ruleDocFor('R6')!.cooldownMin).toBe(1440);
    expect(ruleDocFor('R10')!.account).toBe(true);
    expect(ruleDocFor('R2')!.requiresExact).toBe(true);
    expect(ruleDocFor('R4')!.sourcesText).toBe('todas las fuentes');
    expect(formatThreshold(0.6, 'factor')).toBe('×0,6');
    expect(ruleName('R8')).toBe('Agente en loop');
    expect(thresholdLabel('R4', 'minContentWords')).toBe('Palabras con contenido mínimas');
    expect(ruleDocFor('ZZ')).toBeUndefined();
  });
});
