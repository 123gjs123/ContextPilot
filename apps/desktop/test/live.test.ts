import { describe, expect, it } from 'vitest';
import { MIN_BUCKET_SESSIONS, TEAM_SCHEMA, type TeamExport } from '@contextpilot/core';
import { configToForm, isRecommended, restoreRecommended } from '../src/shared/configForm.js';
import { accountStrip, CARD_STATE_COLOR, cardState, liveCard, NO_DATA_TIP, relTime, stableOrder } from '../src/shared/live.js';
import { initialState, reduce } from '../src/shared/store.js';
import { TEAM_NEVER, teamExportView } from '../src/shared/team.js';
import { decimate, mainThreadPoints, MAX_DOTS, timelineModel, timelineSvg } from '../src/shared/timeline.js';
import type { TimelinePoint } from '../src/shared/types.js';
import { sessionRows, trayMenuModel } from '../src/shared/view.js';
import { NOW, sess, sug } from './helpers.js';

// CP-059 (tarjetas en vivo), CP-061 (nombres), CP-062 (equipo), CP-063 (restaurar), CP-065 (timeline).

function rows(sessions = [sess()], suggestions = [] as ReturnType<typeof sug>[], health = [] as { name: string; status: 'ok' | 'no-data' | 'error' | 'disabled' }[]) {
  return sessionRows(reduce(initialState(), { type: 'hello', data: { version: '1', sessions, suggestions, health } }), NOW);
}

describe('estado y color de la tarjeta (CP-059)', () => {
  it('peor entre medidor (SPEC §9) y severidad; info no alarma; sin datos → gris', () => {
    const base = { noData: false, contextPct: 0.3 as number | null };
    expect(cardState(base, 200_000)).toBe('ok');
    expect(cardState({ ...base, contextPct: 0.55 }, 200_000)).toBe('warn');
    expect(cardState({ ...base, contextPct: 0.8 }, 200_000)).toBe('critical');
    expect(cardState({ ...base, suggestion: { severity: 'info' } }, 200_000)).toBe('critical');
    expect(cardState({ ...base, suggestion: { severity: 'warn' } }, 200_000)).toBe('critical');
    expect(cardState({ ...base, contextPct: 0.55, suggestion: { severity: 'critical' } }, 200_000)).toBe('critical');
    expect(cardState({ ...base, noData: true, suggestion: { severity: 'critical' } }, 200_000)).toBe('nodata');
    expect(cardState({ noData: false, contextPct: 0 }, 0)).toBe('nodata');
    expect(cardState({ noData: false, contextPct: 0, suggestion: { severity: 'warn' } }, 0)).toBe('critical');
    expect(CARD_STATE_COLOR).toEqual({ ok: 'green', warn: 'amber', critical: 'red', nodata: 'gray' });
  });
  it('relTime', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(relTime(at(10_000), NOW)).toBe('ahora');
    expect(relTime(at(2 * 60_000), NOW)).toBe('hace 2 min');
    expect(relTime(at(3 * 3_600_000), NOW)).toBe('hace 3 h');
    expect(relTime('x', NOW)).toBe('—');
  });
  it('orden estable: las existentes no se mueven, las nuevas entran adelante', () => {
    expect(stableOrder([], ['a', 'b'])).toEqual(['a', 'b']);
    expect(stableOrder(['a', 'b'], ['b', 'a', 'c'])).toEqual(['c', 'a', 'b']);
    expect(stableOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
  });
});

describe('tarjeta en vivo (CP-059/060/061)', () => {
  it('con sugerencia: bloque «Buena práctica» con números de la sesión y acciones', () => {
    const s = sess({ contextSize: 144_000, contextPct: 0.72, project: 'contextpilot', title: 'Monitor', displayName: 'contextpilot — Monitor', burn: { tokensPerMin: 12_000, tokensPerHour: 720_000, rawTokensPerMin: 90_000, windowMin: 15, estimated: false } });
    const c = liveCard(rows([s], [sug({ estimatedSavingTokens: 100_000 })])[0]!, NOW);
    expect(c.name).toBe('contextpilot — Monitor');
    expect(c.shortId).toBe('s1');
    expect(c.badge.short).toBe('CC');
    expect(c.state).toBe('critical');
    expect(c.color).toBe('red');
    expect(c.stateLabel).toBe('Buena práctica recomendada');
    expect(c).toMatchObject({ ctxText: '72%', ctxTokensText: '144k / 200k', cacheText: '90%', turnsText: '3', burnText: '12k/min', lastText: 'hace 1 min' });
    expect(c.coaching).toMatchObject({ ruleId: 'R1', ruleName: 'Contexto alto', what: 'El contexto está al 72% (144k de 200k tokens).' });
    expect(c.coaching!.actions).toEqual([{ index: 0, kind: 'copy', label: 'Copiar /compact' }]);
    expect(c.tip).toBeNull();
  });
  it('sin sugerencia: consejo contextual; sin datos: aviso y gris', () => {
    const c = liveCard(rows([sess({ contextPct: 0.46, contextSize: 30_000 })])[0]!, NOW);
    expect(c.coaching).toBeUndefined();
    expect(c.tip).toContain('Cuando pase 60%');
    const nd = liveCard(rows([sess()], [], [{ name: 'claude-code', status: 'error' }])[0]!, NOW);
    expect(nd.state).toBe('nodata');
    expect(nd.tip).toBe(NO_DATA_TIP);
    expect(nd.cacheText).toBe('—');
  });
  it('nombre legible también en tray (fallback al cliente con daemons viejos)', () => {
    const menu = trayMenuModel(reduce(initialState(), { type: 'hello', data: { version: '1', sessions: [sess({ displayName: 'contextpilot — Monitor' }), sess({ sessionId: 'abcdef1234', client: 'claude.ai', source: 'web' })], suggestions: [], health: [] } }), NOW);
    const labels = menu.filter((m) => m.id?.startsWith('session:')).map((m) => m.label);
    expect(labels).toContain('contextpilot — Monitor · s1 — 30%');
    expect(labels).toContain('claude.ai · abcdef12 — 30%');
  });
  it('franja de cuenta: barras 5 h / 7 d y aviso R10', () => {
    const r10 = sug({ id: 'acc', ruleId: 'R10', sessionId: 'account:anthropic', severity: 'critical', title: 'A este ritmo llegás al límite a las 13:00' });
    const snap = { planUsage: { fiveHourPct: 0.8, sevenDayPct: 0.3, sampledAt: new Date(NOW - 5 * 60_000).toISOString(), stale: false }, account: [{ provider: 'anthropic', suggestion: { id: 'acc', ruleId: 'R10', severity: 'critical' as const, title: r10.title, detail: 'd', actions: [] } }] };
    const a = accountStrip(snap, NOW);
    expect(a.plan!.bars.map((b) => [b.text, b.level])).toEqual([['80%', 'red'], ['30%', 'green']]);
    expect(a.plan!.sampledText).toBe('hace 5 min');
    expect(a.warnings[0]).toMatchObject({ providerName: 'Claude', severity: 'critical' });
    expect(accountStrip({}, NOW)).toEqual({ warnings: [] });
  });
});

describe('timeline (CP-065)', () => {
  const t0 = Date.parse('2026-09-30T10:00:00Z');
  const pt = (i: number, ctx: number, sidechain?: boolean | null, stepMs = 20_000): TimelinePoint => ({
    ts: new Date(t0 + i * stepMs).toISOString(), contextSize: ctx, cacheRatio: 0.9, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: false, sidechain,
  });
  it('los subagentes no dibujan contexto', () => {
    const pts = [pt(0, 100_000, false), pt(1, 5000, true), pt(2, 8000, true), pt(3, 102_000, false)];
    expect(mainThreadPoints(pts).map((p) => p.contextSize)).toEqual([100_000, 102_000]);
  });
  it('filas viejas sin marca: caída que se recupera en < 10 min = subagente; compactación real se queda', () => {
    const legacy = [pt(0, 100_000), pt(1, 4000), pt(2, 6000), pt(3, 101_000)];
    expect(mainThreadPoints(legacy).map((p) => p.contextSize)).toEqual([100_000, 101_000]);
    const compact = [pt(0, 150_000, null), pt(1, 30_000, null), pt(2, 32_000, null), pt(3, 35_000, null)];
    expect(mainThreadPoints(compact).map((p) => p.contextSize)).toEqual([150_000, 30_000, 32_000, 35_000]);
    // recupera después de 10 min → era una caída real
    const slow = [pt(0, 100_000), pt(1, 20_000, null, 60_000), pt(15, 90_000, null, 60_000)];
    expect(mainThreadPoints(slow)).toHaveLength(3);
  });
  it('decimación: a lo sumo 4 puntos por columna de píxel, conserva mínimo y máximo', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: 10 + i / 100, y: i === 20 ? 5 : i === 30 ? 95 : 50 }));
    const d = decimate(pts);
    expect(d.length).toBeLessThanOrEqual(4);
    expect(d.map((p) => p.y)).toEqual([50, 5, 95, 50]);
    expect(decimate([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toHaveLength(2);
  });
  it('serie densa: ≤ 1 columna de puntos por píxel y sin círculos por punto', () => {
    const pts = Array.from({ length: 2000 }, (_, i) => pt(i, 20_000 + i * 50, i % 7 === 3 ? true : false, 1000));
    const m = timelineModel(pts, 200_000, [], 720, 240);
    const cols = new Map<number, number>();
    for (const p of m.context) cols.set(Math.floor(p.x), (cols.get(Math.floor(p.x)) ?? 0) + 1);
    expect(Math.max(...cols.values())).toBeLessThanOrEqual(4);
    expect(m.context.length).toBeGreaterThan(MAX_DOTS);
    expect((timelineSvg(m).match(/class="pt s1"/g) ?? []).length).toBe(1);
  });
});

describe('equipo: vista previa de la exportación (CP-062)', () => {
  const exp: TeamExport = {
    schema: TEAM_SCHEMA, generatedAt: '2026-09-30', minBucketSessions: 5, contributors: 1, weeks: ['2026-W40'],
    byProvider: [{ week: '2026-W40', provider: 'anthropic', sessions: 6, input: 1000, output: 2000, cacheRead: 9000, cacheWrite: 0, suggestions: 4, accepted: 3, dismissed: 1, snoozed: 0, savedTokens: 50_000 }],
    byRule: [{ week: '2026-W40', ruleId: 'R1', sessions: 5, fired: 4, accepted: 3, dismissed: 1, snoozed: 0, acceptanceRate: 0.75, savedTokens: 50_000 }],
    suppressedBuckets: 2,
  };
  it('filas legibles, totales y grupos ocultos', () => {
    const v = teamExportView(exp);
    expect(v.ok).toBe(true);
    expect(v.totals).toMatchObject({ sessions: 6, tokensText: '12k', suggestions: 4, accepted: 3, acceptanceText: '75%', savedText: '≈50k' });
    expect(v.providers[0]).toMatchObject({ provider: 'Anthropic (Claude)', cacheText: '90%' });
    expect(v.rules[0]).toMatchObject({ ruleName: 'Contexto alto', acceptanceText: '75%' });
    expect(v.suppressedText).toContain('2 grupo(s) ocultos');
    expect(teamExportView({ ...exp, byProvider: [], byRule: [] }).empty).toBe(true);
    expect(teamExportView({ foo: 1 }).ok).toBe(false);
    expect(TEAM_NEVER.join(' ')).toContain(`menos de ${MIN_BUCKET_SESSIONS} sesiones`);
  });
});

describe('configuración: restaurar recomendado (CP-063)', () => {
  it('vuelve umbrales y cooldown a los defaults sin tocar «activa»', () => {
    const f = configToForm({ rules: { R1: { enabled: false, thresholds: { pct: 0.8 }, cooldownMs: 5 * 60_000 } }, providerOverrides: {}, adapters: {}, plans: [], storeContent: {}, maxVisiblePerSession: 1 });
    const r = f.rules[0]!;
    expect(isRecommended(r)).toBe(false);
    const back = restoreRecommended(r);
    expect(back).toEqual({ id: 'R1', enabled: false, cooldownMin: 20, thresholds: [{ key: 'pct', value: 0.6 }] });
    expect(isRecommended(back)).toBe(true);
  });
});
