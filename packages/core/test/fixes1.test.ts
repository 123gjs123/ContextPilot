import { describe, expect, it } from 'vitest';
import {
  R1,
  R10,
  R2,
  R3,
  R4,
  R5,
  R6,
  R8,
  RuleEngine,
  W2,
  accountSessionId,
  applyEvent,
  defaultConfig,
  embed,
  mergeConfig,
  shortAction,
  toolExample,
  type Rule,
  type RuleContext,
  type SessionState,
  type Suggestion,
  type TurnEvent,
} from '../src/index.js';
import { ev, run } from './helpers.js';

// Defectos D-1, D-2, D-3, D-4, D-6, D-11, D-13, D-14, D-18 de docs/ACCEPTANCE.md §4.

const MIN = 60_000;
const NOW = Date.parse('2026-09-29T12:00:00Z');

function evalRule(rule: Rule, event: TurnEvent, state: SessionState, prev?: SessionState, extra: Partial<RuleContext> = {}) {
  return rule.evaluate({ event, state, prev, thresholds: { ...rule.defaults }, now: NOW, ...extra });
}

const ctxEv = (contextSize: number, over: Partial<TurnEvent> = {}) =>
  ev({ contextSize, tokens: { input: 10, output: 100, cacheRead: contextSize - 110, cacheWrite: 0, estimated: false }, ...over });

const PLAN = { provider: 'anthropic' as const, kind: 'subscription' as const, windowMs: 5 * 60 * MIN, windowBudgetTokens: 1_000_000 };
/** Ritmo que agota el plan antes del fin de la ventana. */
const hotPoints = Array.from({ length: 10 }, (_, i) => ({ ts: NOW - (60 - i * 6) * MIN, tokens: 60_000 }));

describe('D-1: R10 es una señal de cuenta', () => {
  const engine = () => new RuleEngine(mergeConfig(defaultConfig(), { plans: [PLAN] }));
  const evalAt = (eng: RuleEngine, e: TurnEvent, now = NOW) =>
    eng.evaluate({ event: e, state: applyEvent(undefined, e), now, usageWindow: { provider: 'anthropic', points: hotPoints } });

  it('R10 sale con sessionId account:<proveedor> y NO bloquea a R1 de la sesión', () => {
    const eng = engine();
    const out = evalAt(eng, ctxEv(130_000, { sessionId: 'A' }));
    const ids = out.published.map((s) => `${s.ruleId}@${s.sessionId}`).sort();
    expect(ids).toEqual(['R10@account:anthropic', 'R1@A'].sort());
    expect(eng.visibleFor('A', NOW)?.ruleId).toBe('R1');
    expect(eng.visibleFor(accountSessionId('anthropic'), NOW)?.ruleId).toBe('R10');
  });

  it('una sola por proveedor: en 50 sesiones nuevas R10 se publica 1 vez y R1 50 veces', () => {
    const eng = engine();
    const fired: Record<string, number> = {};
    for (let i = 0; i < 50; i++) {
      for (const s of evalAt(eng, ctxEv(130_000, { sessionId: `S${i}` }), NOW + i * 1000).published) fired[s.ruleId] = (fired[s.ruleId] ?? 0) + 1;
    }
    expect(fired).toEqual({ R1: 50, R10: 1 });
  });

  it('otro proveedor tiene su propio lugar de cuenta', () => {
    const eng = new RuleEngine(mergeConfig(defaultConfig(), { plans: [PLAN, { ...PLAN, provider: 'openai' }] }));
    const a = evalAt(eng, ctxEv(10_000, { sessionId: 'A' }));
    const o = eng.evaluate({
      event: ctxEv(10_000, { sessionId: 'B', provider: 'openai', source: 'codex' }),
      state: applyEvent(undefined, ctxEv(10_000, { sessionId: 'B', provider: 'openai', source: 'codex' })),
      now: NOW,
      usageWindow: { provider: 'openai', points: hotPoints },
    });
    expect(a.published.map((s) => s.sessionId)).toEqual(['account:anthropic']);
    expect(o.published.map((s) => s.sessionId)).toEqual(['account:openai']);
  });

  it('R10 declara scope account', () => expect(R10.scope).toBe('account'));
});

describe('D-2: R1 warn desde el umbral', () => {
  it('61 % → warn (CP-010.1); payload base /compact (el foco lo agrega el daemon)', () => {
    const e = ctxEv(122_000);
    const res = evalRule(R1, e, run([e]).state);
    expect(res?.severity).toBe('warn');
    expect(res?.actions[0]).toMatchObject({ kind: 'copy', payload: '/compact' });
  });
});

describe('D-3: acción corta de statusline por regla', () => {
  const sug = (ruleId: string, actions: Suggestion['actions'], title = 't'): Suggestion =>
    ({ id: 'x', ruleId, sessionId: 'S', severity: 'warn', title, detail: '', actions, expiresAt: '' }) as Suggestion;
  it('R5 → grep/head (nunca la primera palabra del texto a copiar)', () => {
    const r5 = evalRule(R5, ev({ toolCalls: [{ name: 'Read', resultTokens: 20_000, failed: false, argsHash: '' }] }), run([ev()]).state)!;
    expect(shortAction({ ruleId: 'R5', ...r5 })).toBe('grep/head');
  });
  it('R1 → /compact aunque el payload tenga foco; R2/W1 → traspaso; R8 → loop!; R10 → límite hh:mm', () => {
    expect(shortAction(sug('R1', [{ kind: 'copy', label: 'c', payload: '/compact Conservá el trabajo sobre a.ts' }]))).toBe('/compact');
    expect(shortAction(sug('G2', [{ kind: 'copy', label: 'c', payload: '/compress' }]))).toBe('/compress');
    expect(shortAction(sug('R2', [{ kind: 'handoff', label: 'h' }, { kind: 'copy', label: 'c', payload: '/clear' }]))).toBe('traspaso');
    expect(shortAction(sug('W1', [{ kind: 'handoff', label: 'h' }]))).toBe('traspaso');
    expect(shortAction(sug('R8', [{ kind: 'show-detail', label: 'v' }]))).toBe('loop!');
    expect(shortAction(sug('R10', [{ kind: 'show-detail', label: 'v' }], 'A este ritmo llegás al límite a las 12:58'))).toBe('límite 12:58');
    expect(shortAction(sug('W3', [{ kind: 'copy', label: 'c', payload: 'La respuesta anterior no sirve' }]))).toBe('reformulá');
  });
});

describe('D-18: R2 una emisión por pausa', () => {
  const big = ctxEv(150_000, { cacheTtlMs: 5 * MIN });
  it('con evento prompt previo, la respuesta que re-escribe la caché no vuelve a emitir', () => {
    const { state } = run([big]);
    const p = ev({ phase: 'prompt', idleSincePrevMs: 10 * MIN, tokens: { input: 0, output: 0, estimated: false }, contextSize: 0 });
    const afterPrompt = applyEvent(state, p);
    expect(evalRule(R2, p, afterPrompt, state)?.severity).toBe('warn');
    const resp = ev({ idleSincePrevMs: 10 * MIN, contextSize: 150_000, tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 149_000, estimated: false } });
    expect(evalRule(R2, resp, applyEvent(afterPrompt, resp), afterPrompt)).toBeNull();
  });
  it('sin evento prompt (proxy), la respuesta emite info una vez', () => {
    const { state } = run([big]);
    const resp = ev({ source: 'proxy', idleSincePrevMs: 10 * MIN, contextSize: 150_000, tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 149_000, estimated: false } });
    expect(evalRule(R2, resp, applyEvent(state, resp), state)?.severity).toBe('info');
  });
  it('skipRules evita R2 en el prompt que cierra una pausa ya avisada', () => {
    const eng = new RuleEngine(undefined, [R2]);
    const { state } = run([big]);
    const p = ev({ phase: 'prompt', idleSincePrevMs: 10 * MIN, tokens: { input: 0, output: 0, estimated: false }, contextSize: 0 });
    expect(eng.evaluate({ event: p, prev: state, state: applyEvent(state, p), now: NOW, skipRules: ['R2'] }).published).toHaveLength(0);
  });
});

describe('D-14: R3 lista cambios de system prompt y de modelo ocurridos antes del último turno', () => {
  const withRatio = (r: number, over: Partial<TurnEvent> = {}) =>
    ev({ contextSize: 10_000, tokens: { input: Math.round(10_000 * (1 - r)), cacheRead: Math.round(10_000 * r), cacheWrite: 0, output: 10, estimated: false }, ...over });
  it('hash de system prompt distinto en el turno malo → «system prompt cambió»', () => {
    const { prev, state } = run([withRatio(0.9, { systemHash: 'h1' }), withRatio(0.2, { systemHash: 'h2' }), withRatio(0.3, { systemHash: 'h2' })]);
    expect(evalRule(R3, withRatio(0.3), state, prev)?.detail).toContain('system prompt');
  });
  it('cambio de modelo 2 turnos antes también se lista', () => {
    const { prev, state } = run([withRatio(0.9), withRatio(0.2, { model: 'claude-opus-4-1' }), withRatio(0.3, { model: 'claude-opus-4-1' })]);
    expect(evalRule(R3, withRatio(0.3), state, prev)?.detail).toContain('modelo claude-sonnet-4-5 → claude-opus-4-1');
  });
});

describe('D-6: R4 trae handoff y open-session (CP-019.3)', () => {
  it('acciones', () => {
    const topic = 'refactor del parser de transcripts jsonl deduplicar message id usage tokens';
    const p = (text: string) => ev({ phase: 'prompt', promptEmbedding: embed(text), promptTokens: 40, tokens: { input: 0, output: 0, estimated: false } });
    const st = run([p(topic), p(topic + ' tests'), p('parser jsonl usage dedupe message'), ctxEv(30_000)]).state;
    const e = p('receta de torta de chocolate con harina y huevos para cumpleaños');
    expect(evalRule(R4, e, applyEvent(st, e), st)?.actions.map((a) => a.kind)).toEqual(['handoff', 'open-session', 'copy']);
  });
});

describe('D-14: R5 con ejemplo por herramienta (CP-010.4)', () => {
  it.each([
    ['Read', 'offset/limit'],
    ['Bash', 'head -50'],
    ['Grep', 'head_limit'],
    ['WebFetch', 'resumen'],
    ['mcp__jira__search', 'subagente'],
  ])('%s → ejemplo con «%s» en acción show-detail', (name, needle) => {
    const e = ev({ toolCalls: [{ name, resultTokens: 20_000, failed: false, argsHash: '' }] });
    const res = evalRule(R5, e, run([e]).state)!;
    expect(res.actions[0]).toMatchObject({ kind: 'show-detail' });
    expect(res.actions[0]!.payload).toContain(needle);
    expect(toolExample(name)).toContain(needle);
  });
});

describe('D-4: R6 alcanzable (proxy y Claude Code con inventario MCP)', () => {
  it('sources incluye proxy y claude-code', () => {
    expect(R6.sources).toContain('proxy');
    expect(R6.sources).toContain('claude-code');
  });
  it('servidor MCP agrupado: se considera usado si se usó cualquiera de sus herramientas; costo ≈', () => {
    const tools = [
      { name: 'mcp__jira', definitionTokens: 1500, estimated: true },
      { name: 'mcp__drive', definitionTokens: 900, estimated: true },
    ];
    const at = (turn: number) =>
      ev({ turn, toolsAvailable: tools, toolCalls: turn === 15 ? [{ name: 'mcp__drive__search', resultTokens: 1, failed: false, argsHash: '' }] : undefined });
    const st = run(Array.from({ length: 21 }, (_, i) => at(i + 1))).state;
    const res = evalRule(R6, at(21), st)!;
    expect(res.title).toContain('≈');
    expect(res.detail).toContain('mcp__jira');
    expect(res.detail).not.toContain('mcp__drive');
  });
  it('vía motor con fuente proxy (exacto)', () => {
    const tools = [{ name: 'big_tool', definitionTokens: 2000 }];
    const eng = new RuleEngine(undefined, [R6]);
    let st: SessionState | undefined;
    let out: ReturnType<RuleEngine['evaluate']> | undefined;
    for (let t = 1; t <= 21; t++) {
      const e = ev({ source: 'proxy', turn: t, toolsAvailable: tools });
      const prev = st;
      st = applyEvent(prev, e);
      out = eng.evaluate({ event: e, prev, state: st, now: NOW });
      if (out.published.length) break;
    }
    expect(out!.published[0]?.ruleId).toBe('R6');
    expect(out!.published[0]?.title).not.toContain('≈');
  });
});

describe('D-13: R8 con comando y 3 timestamps (CP-012.1)', () => {
  it('detalle', () => {
    const fail = (ts: string) => ev({ ts, toolCalls: [{ name: 'Bash', resultTokens: 10, failed: true, argsHash: 'abcdef1234567890' }] });
    const { state } = run([fail('2026-09-29T10:00:01.000Z'), fail('2026-09-29T10:00:05.000Z'), fail('2026-09-29T10:00:09.000Z')]);
    const res = evalRule(R8, fail('x'), state)!;
    expect(res.severity).toBe('critical');
    expect(res.detail).toContain('Comando: Bash (args #abcdef12)');
    expect(res.detail).toContain('10:00:01, 10:00:05, 10:00:09');
    expect(res.actions[0]!.kind).toBe('show-detail');
  });
});

describe('D-15: R10 con dos ventanas (5 h + 7 días) y critical (CP-018.2, CP-055.1)', () => {
  const plan2 = {
    provider: 'anthropic' as const,
    kind: 'subscription' as const,
    windows: [
      { hours: 5, limit: 10_000_000 },
      { days: 7, limit: 1_000_000 },
    ],
  };
  it('se agota primero la de 7 días: la informa con su etiqueta, severidad critical', () => {
    const res = evalRule(R10, ev(), run([ev()]).state, undefined, { plan: plan2, usageWindow: { provider: 'anthropic', points: hotPoints } });
    expect(res?.severity).toBe('critical');
    expect(res?.title).toContain('ventana de 7 d');
  });
  it('series separadas por ventana (byWindow): la de 5 h holgada y la de 7 d no', () => {
    const cold = hotPoints.map((p) => ({ ...p, tokens: 1 }));
    const plan = { ...plan2, windows: [{ hours: 5, limit: 1_000_000 }, { days: 7, limit: 1_000_000 }] };
    const res = evalRule(R10, ev(), run([ev()]).state, undefined, {
      plan,
      usageWindow: { provider: 'anthropic', points: cold, byWindow: { '5h': cold, '168h': hotPoints } },
    });
    expect(res?.title).toContain('7 d');
    const none = evalRule(R10, ev(), run([ev()]).state, undefined, {
      plan,
      usageWindow: { provider: 'anthropic', points: cold, byWindow: { '5h': cold, '168h': cold } },
    });
    expect(none).toBeNull();
  });
});

describe('D-11: W2 entre conversaciones del mismo sitio', () => {
  it('1 subida en esta conversación + 1 en otra (siteAttachmentCounts=2) → dispara', () => {
    const a = ev({ source: 'web', client: 'claude.ai', attachments: [{ hash: 'A', tokens: 3000 }], tokens: { input: 1, output: 1, estimated: true } });
    const st = run([a]).state;
    expect(evalRule(W2, a, st)).toBeNull();
    expect(evalRule(W2, a, st, undefined, { siteAttachmentCounts: { A: 2 } })?.detail).toContain('Project');
  });
});

describe('lugar visible: desempate por ahorro también contra la vigente', () => {
  it('R2 (pausa, warn, ahorro mayor) reemplaza a un R1 warn vigente; R1 no reemplaza a R2', () => {
    const eng = new RuleEngine(undefined, [R1, R2]);
    const big = ctxEv(150_000, { cacheTtlMs: 5 * MIN });
    const st = applyEvent(undefined, big);
    expect(eng.evaluate({ event: big, state: st, now: NOW }).published.map((s) => s.ruleId)).toEqual(['R1']);
    const p = ev({ phase: 'prompt', idleSincePrevMs: 6 * MIN, tokens: { input: 0, output: 0, estimated: false }, contextSize: 0 });
    const out = eng.evaluate({ event: p, prev: st, state: applyEvent(st, p), now: NOW + 6 * MIN });
    expect(out.published.map((s) => s.ruleId)).toEqual(['R2']);
    expect(eng.visibleFor('S1', NOW + 6 * MIN)?.ruleId).toBe('R2');
  });
});
