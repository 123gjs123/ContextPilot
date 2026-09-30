import { describe, expect, it } from 'vitest';
import {
  ALL_RULES,
  G1,
  G2,
  R1,
  R10,
  R2,
  R3,
  R4,
  R5,
  R6,
  R7,
  R8,
  R9,
  RuleEngine,
  W1,
  W2,
  W3,
  W4,
  applyEvent,
  embed,
  type Rule,
  type RuleContext,
  type SessionState,
  type TurnEvent,
} from '../src/index.js';
import { ev, run } from './helpers.js';

const MIN = 60_000;
const NOW = Date.parse('2026-09-29T12:00:00Z');

/** Evalúa una regla directamente con los umbrales default. */
function evalRule(rule: Rule, event: TurnEvent, state: SessionState, prev?: SessionState, extra: Partial<RuleContext> = {}) {
  return rule.evaluate({ event, state, prev, thresholds: { ...rule.defaults }, now: NOW, ...extra });
}

/** Evalúa vía motor (respeta sources/requiresExact/on) con sólo esa regla. */
function viaEngine(rule: Rule, events: TurnEvent[]) {
  const eng = new RuleEngine(undefined, [rule]);
  let st: SessionState | undefined;
  let last: ReturnType<RuleEngine['evaluate']> | undefined;
  for (const e of events) {
    const prev = st;
    st = applyEvent(prev, e);
    last = eng.evaluate({ event: e, prev, state: st, now: NOW });
  }
  return last!;
}

const ctxEv = (contextSize: number, over: Partial<TurnEvent> = {}) =>
  ev({ contextSize, tokens: { input: 10, output: 100, cacheRead: contextSize - 110, cacheWrite: 0, estimated: false }, ...over });

describe('catálogo', () => {
  it('las 16 reglas del SPEC §5: ids únicos y sources declaradas', () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['G1', 'G2', 'R1', 'R10', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'W1', 'W2', 'W3', 'W4'].sort());
    for (const r of ALL_RULES) expect(r.sources.length).toBeGreaterThan(0);
  });
});

describe('R1 contexto', () => {
  it('dispara > 60 % con /compact (Claude Code, Codex) y /compress (Gemini CLI)', () => {
    for (const [source, provider, cmd] of [
      ['claude-code', 'anthropic', '/compact'],
      ['codex', 'openai', '/compact'],
      ['gemini-cli', 'google', '/compress'],
    ] as const) {
      const e = ctxEv(122_000, { source, provider, contextWindow: 200_000 });
      const res = evalRule(R1, e, run([e]).state);
      expect(res?.actions[0]).toMatchObject({ kind: 'copy', payload: cmd });
    }
  });
  it('no dispara a 59 %', () => {
    const e = ctxEv(118_000);
    expect(evalRule(R1, e, run([e]).state)).toBeNull();
  });
  it('histéresis: dentro del mismo escalón no repite', () => {
    const { prev, state } = run([ctxEv(124_000), ctxEv(130_000)]);
    expect(evalRule(R1, ctxEv(130_000), state, prev)).toBeNull();
    const s2 = run([ctxEv(130_000), ctxEv(142_000)]);
    expect(evalRule(R1, ctxEv(142_000), s2.state, s2.prev)).not.toBeNull();
  });
  it('no aplica a web (sources)', () => {
    expect(viaEngine(R1, [ctxEv(150_000, { source: 'web', tokens: { input: 150_000, output: 0, estimated: true } })]).published).toHaveLength(0);
  });
});

describe('R2 pausa > TTL', () => {
  const big = ctxEv(150_000, { cacheTtlMs: 5 * MIN });
  const prompt = (idle: number, over: Partial<TurnEvent> = {}) => ev({ phase: 'prompt', idleSincePrevMs: idle, tokens: { input: 0, output: 0, estimated: false }, contextSize: 0, ...over });

  it('TTL 5 min: a 5 min + 1 s dispara warn con handoff y /clear', () => {
    const { state } = run([big]);
    const p = prompt(5 * MIN + 1000);
    const res = evalRule(R2, p, applyEvent(state, p), state);
    expect(res?.severity).toBe('warn');
    expect(res?.actions.map((a) => a.kind)).toEqual(['handoff', 'copy']);
    expect(res?.actions[1]?.payload).toBe('/clear');
  });
  it('TTL 1 h: 40 min no, 60 min + 1 s sí', () => {
    const { state } = run([ctxEv(150_000, { cacheTtlMs: 60 * MIN })]);
    const p40 = prompt(40 * MIN);
    expect(evalRule(R2, p40, applyEvent(state, p40), state)).toBeNull();
    const p61 = prompt(60 * MIN + 1000);
    expect(evalRule(R2, p61, applyEvent(state, p61), state)).not.toBeNull();
  });
  it('contexto 49k no dispara', () => {
    const { state } = run([ctxEv(49_000)]);
    const p = prompt(10 * MIN);
    expect(evalRule(R2, p, applyEvent(state, p), state)).toBeNull();
  });
  it('exige exacto: sesión estimada no dispara vía motor', () => {
    const est = ctxEv(150_000, { tokens: { input: 150_000, output: 0, estimated: true } });
    expect(viaEngine(R2, [est, prompt(10 * MIN)]).published).toHaveLength(0);
    expect(viaEngine(R2, [big, prompt(10 * MIN)]).published).toHaveLength(1);
  });
  it('Codex sugiere /new', () => {
    const e = ctxEv(150_000, { source: 'codex', provider: 'openai' });
    const { state } = run([e]);
    const p = prompt(10 * MIN, { source: 'codex', provider: 'openai' });
    expect(evalRule(R2, p, applyEvent(state, p), state)?.actions[1]?.payload).toBe('/new');
  });
});

describe('R3 caída de caché', () => {
  const withRatio = (r: number) => ev({ contextSize: 10_000, tokens: { input: Math.round(10_000 * (1 - r)), cacheRead: Math.round(10_000 * r), cacheWrite: 0, output: 10, estimated: false } });
  it('2 turnos bajo 50 % tras uno sano dispara', () => {
    const { prev, state } = run([withRatio(0.9), withRatio(0.2), withRatio(0.3)]);
    expect(evalRule(R3, withRatio(0.3), state, prev)?.severity).toBe('warn');
  });
  it('1 solo turno bajo no dispara', () => {
    const { prev, state } = run([withRatio(0.9), withRatio(0.9), withRatio(0.3)]);
    expect(evalRule(R3, withRatio(0.3), state, prev)).toBeNull();
  });
  it('detecta cambio de modelo', () => {
    const { prev, state } = run([withRatio(0.9), withRatio(0.2), { ...withRatio(0.3), model: 'claude-opus-4' }]);
    expect(evalRule(R3, withRatio(0.3), state, prev)?.detail).toContain('modelo');
  });
});

describe('R4 tarea nueva', () => {
  const topic = 'refactor del parser de transcripts jsonl deduplicar message id usage tokens';
  const p = (text: string, over: Partial<TurnEvent> = {}) => ev({ phase: 'prompt', promptEmbedding: embed(text), promptTokens: 40, tokens: { input: 0, output: 0, estimated: false }, ...over });
  const base = () => run([p(topic), p(topic + ' tests'), p('parser jsonl usage dedupe message'), ctxEv(30_000)]).state;
  it('prompt no relacionado dispara con open-session', () => {
    const st = base();
    const e = p('receta de torta de chocolate con harina y huevos para cumpleaños');
    const res = evalRule(R4, e, applyEvent(st, e), st);
    expect(res?.actions.map((a) => a.kind)).toContain('open-session');
  });
  it('prompt del mismo tema no dispara; prompt corto tampoco', () => {
    const st = base();
    const same = p('seguimos con el parser jsonl: dedupe por message id y suma de usage tokens');
    expect(evalRule(R4, same, applyEvent(st, same), st)).toBeNull();
    const short = p('receta de torta', { promptTokens: 5 });
    expect(evalRule(R4, short, applyEvent(st, short), st)).toBeNull();
  });
});

describe('R5 resultado grande', () => {
  const tc = (resultTokens: number) => ev({ toolCalls: [{ name: 'Read', resultTokens, failed: false, argsHash: 'a' }] });
  it('10 001 dispara info; 10 000 no', () => {
    expect(evalRule(R5, tc(10_001), run([tc(10_001)]).state)?.severity).toBe('info');
    expect(evalRule(R5, tc(10_000), run([tc(10_000)]).state)).toBeNull();
  });
  it('sólo CLI: proxy no se evalúa', () => {
    expect(viaEngine(R5, [{ ...tc(20_000), source: 'proxy' }]).published).toHaveLength(0);
    expect(viaEngine(R5, [tc(20_000)]).published).toHaveLength(1);
  });
});

describe('R6 herramientas sin uso', () => {
  const tools = [
    { name: 'mcp__big', definitionTokens: 1500 },
    { name: 'Read', definitionTokens: 300 },
  ];
  it('20 turnos sin uso dispara con costo; 19 no', () => {
    const at = (turn: number) => ev({ turn, toolsAvailable: tools, toolCalls: turn === 1 ? [{ name: 'Read', resultTokens: 1, failed: false, argsHash: '' }] : undefined });
    const s20 = run(Array.from({ length: 21 }, (_, i) => at(i + 1))).state;
    expect(evalRule(R6, at(21), s20)?.title).toContain('herramientas');
    const s19 = run(Array.from({ length: 19 }, (_, i) => at(i + 1))).state;
    expect(evalRule(R6, at(19), s19)).toBeNull();
  });
  it('exige exacto', () => expect(R6.requiresExact).toBe(true));
});

describe('R7 tarea trivial en modelo caro', () => {
  const e = (promptTokens: number, model = 'claude-opus-4-1') => ev({ model, promptTokens, tokens: { input: 50, output: 100, estimated: false }, contextSize: 5000 });
  it('opus + prompt 150 + respuesta 100 dispara /model sonnet', () => {
    expect(evalRule(R7, e(150), run([e(150)]).state)?.actions[0]?.payload).toBe('/model sonnet');
  });
  it('prompt 200 no dispara; modelo mid no dispara', () => {
    expect(evalRule(R7, e(200), run([e(200)]).state)).toBeNull();
    expect(evalRule(R7, e(50, 'claude-sonnet-4-5'), run([e(50, 'claude-sonnet-4-5')]).state)).toBeNull();
  });
});

describe('R8 loop', () => {
  const fail = (argsHash = 'x', failed = true) => ev({ toolCalls: [{ name: 'Bash', resultTokens: 10, failed, argsHash }] });
  it('3 fallos iguales → critical', () => {
    const { state } = run([fail(), fail(), fail()]);
    expect(evalRule(R8, fail(), state)?.severity).toBe('critical');
  });
  it('éxito intermedio o args distintos reinician', () => {
    expect(evalRule(R8, fail(), run([fail(), fail('x', false), fail()]).state)).toBeNull();
    expect(evalRule(R8, fail(), run([fail(), fail('y'), fail()]).state)).toBeNull();
  });
});

describe('R9 bloque repetido', () => {
  const b = (tokens: number) => ev({ phase: 'prompt', blocks: [{ hash: 'H', tokens }], tokens: { input: 0, output: 0, estimated: false } });
  it('2 veces > 2k dispara; 1 vez o ≤ 2k no', () => {
    expect(evalRule(R9, b(2500), run([b(2500), b(2500)]).state)).not.toBeNull();
    expect(evalRule(R9, b(2500), run([b(2500)]).state)).toBeNull();
    expect(evalRule(R9, b(2000), run([b(2000), b(2000)]).state)).toBeNull();
  });
});

describe('R10 proyección de límite', () => {
  const plan = { provider: 'anthropic' as const, kind: 'subscription' as const, windowMs: 5 * 60 * MIN, windowBudgetTokens: 1_000_000 };
  it('ritmo que agota antes del fin de ventana dispara con hora', () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ ts: NOW - (60 - i * 6) * MIN, tokens: 60_000 }));
    const e = ev();
    const res = evalRule(R10, e, run([e]).state, undefined, { plan, usageWindow: { provider: 'anthropic', points } });
    expect(res?.title).toMatch(/\d\d:\d\d/);
  });
  it('ritmo bajo no dispara; sin plan no dispara', () => {
    const points = Array.from({ length: 5 }, (_, i) => ({ ts: NOW - (60 - i * 10) * MIN, tokens: 1000 }));
    const e = ev();
    expect(evalRule(R10, e, run([e]).state, undefined, { plan, usageWindow: { provider: 'anthropic', points } })).toBeNull();
    expect(evalRule(R10, e, run([e]).state, undefined, { usageWindow: { provider: 'anthropic', points } })).toBeNull();
  });
});

describe('W1 conversación web larga', () => {
  const w = (contextSize: number, turn: number, source: 'web' | 'desktop' = 'web') =>
    ev({ source, client: 'claude.ai', contextSize, turn, tokens: { input: contextSize, output: 0, estimated: true } });
  it('80 001 tokens o 41 turnos dispara handoff; 80 000 y 40 no', () => {
    expect(evalRule(W1, w(80_001, 3), run([w(80_001, 3)]).state)?.actions[0]?.kind).toBe('handoff');
    expect(evalRule(W1, w(1000, 41), run([w(1000, 41)]).state)).not.toBeNull();
    expect(evalRule(W1, w(80_000, 40), run([w(80_000, 40)]).state)).toBeNull();
  });
  it('aplica a desktop; no a CLI', () => {
    expect(viaEngine(W1, [w(90_000, 1, 'desktop')]).published).toHaveLength(1);
    expect(viaEngine(W1, [ctxEv(90_000)]).published).toHaveLength(0);
  });
});

describe('W2 adjunto re-subido', () => {
  const a = (client = 'chatgpt.com') => ev({ source: 'web', client, attachments: [{ hash: 'A', tokens: 3000 }], tokens: { input: 1, output: 1, estimated: true } });
  it('2 veces dispara con Project/GPT; 1 vez no', () => {
    expect(evalRule(W2, a(), run([a(), a()]).state)?.detail).toContain('GPT');
    expect(evalRule(W2, a(), run([a()]).state)).toBeNull();
    expect(evalRule(W2, a('gemini.google.com'), run([a('gemini.google.com'), a('gemini.google.com')]).state)?.detail).toContain('Gem');
  });
});

describe('W3 regeneraciones', () => {
  const r = () => ev({ source: 'web', regenerated: true, tokens: { input: 1, output: 1, estimated: true } });
  it('3 dispara info show/copy; 2 no', () => {
    expect(evalRule(W3, r(), run([r(), r(), r()]).state)?.severity).toBe('info');
    expect(evalRule(W3, r(), run([r(), r()]).state)).toBeNull();
  });
});

describe('W4 modo caro', () => {
  const m = (promptTokens: number) => ev({ source: 'web', expensiveMode: 'Razonamiento extendido', promptTokens, tokens: { input: 1, output: 1, estimated: true } });
  it('prompt < 200 dispara show-detail; 200 no', () => {
    expect(evalRule(W4, m(50), run([m(50)]).state)?.actions[0]?.kind).toBe('show-detail');
    expect(evalRule(W4, m(200), run([m(200)]).state)).toBeNull();
  });
});

describe('G1 tramo de precio Gemini', () => {
  const g = (prompt: number, estimated = false) =>
    ev({ source: 'gemini-cli', provider: 'google', model: 'gemini-2.5-pro', contextSize: prompt, tokens: { input: prompt, output: 0, cacheRead: 0, estimated } });
  it('cruzar 200k dispara /compress; lejos del tramo no', () => {
    const prev = run([g(150_000)]).state;
    const e = g(200_001);
    expect(evalRule(G1, e, applyEvent(prev, e), prev)?.actions[0]?.payload).toBe('/compress');
    expect(evalRule(G1, g(100_000), run([g(100_000)]).state, run([g(90_000)]).state)).toBeNull();
  });
  it('estimado no dispara (motor)', () => {
    expect(viaEngine(G1, [g(150_000, true), g(200_001, true)]).published).toHaveLength(0);
    expect(viaEngine(G1, [g(150_000), g(200_001)]).published).toHaveLength(1);
  });
});

describe('G2 contexto absoluto', () => {
  const g = (ctx: number, provider: 'google' | 'anthropic' = 'google') => ev({ source: 'gemini-cli', provider, contextSize: ctx, model: 'gemini-2.5-flash' });
  it('> 200k dispara; 200k no; otro proveedor no', () => {
    expect(evalRule(G2, g(200_001), run([g(200_001)]).state)?.actions[0]?.payload).toBe('/compress');
    expect(evalRule(G2, g(200_000), run([g(200_000)]).state)).toBeNull();
    expect(evalRule(G2, g(300_000, 'anthropic'), run([g(300_000, 'anthropic')]).state)).toBeNull();
  });
});
