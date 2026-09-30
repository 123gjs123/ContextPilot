import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePlanSamples, planUsagePoints } from '../src/adapters/planUsage.js';
import { statuslineText } from '../src/server.js';
import { ev, rmrf, startTestDaemon, tempDir, waitFor } from './helpers.js';

// plan-usage-history.json de Claude Desktop (docs/SPIKE-desktop.md) → /stats y R10.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

const MIN = 60_000;

function history(now: number, fh: number[], org = 'org-a') {
  return {
    version: 2,
    samples: [
      { t: now - 10 * 3_600_000, org: 'otra-org', u: { fh: 99, sd: 99 } },
      ...fh.map((v, i) => ({ t: now - (fh.length - 1 - i) * 15 * MIN - MIN, org, u: { fh: v, sd: 30 + i } })),
    ],
  };
}

describe('parser de plan-usage', () => {
  it('toma la organización de la muestra más reciente y arma la serie de %', () => {
    const now = Date.now();
    const s = parsePlanSamples(JSON.stringify(history(now, [10, 20, 5, 15])))!;
    expect(s.every((x) => x.fh !== 99)).toBe(true);
    // la caída 20 → 5 es una ventana nueva: la serie arranca ahí
    expect(planUsagePoints(s, now).map((p) => p.tokens)).toEqual([5, 10]);
    expect(parsePlanSamples('no json')).toBeNull();
    expect(parsePlanSamples('{"samples":[]}')).toEqual([]);
  });
});

describe('adaptador claude-plan-usage', () => {
  it('health ok, /stats.planUsage y R10 con dato exacto del proveedor', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const file = join(dir, 'plan-usage-history.json');
    const now = Date.now();
    writeFileSync(file, JSON.stringify(history(now, [10, 15, 20, 25, 30, 40, 55, 70, 80])));
    const env = { ...process.env, CONTEXTPILOT_PLAN_USAGE_FILE: file };
    const t = await startTestDaemon({ env });
    expect(t.d.health.get('claude-plan-usage')?.status).toBe('ok');
    const stats = (await (await t.api('/stats')).json()) as { planUsage: { fiveHourPct: number; sevenDayPct: number; stale: boolean } };
    expect(stats.planUsage.fiveHourPct).toBeCloseTo(0.8);
    expect(stats.planUsage.sevenDayPct).toBeCloseTo(0.38);
    expect(stats.planUsage.stale).toBe(false);
    // el id de organización nunca sale del daemon
    expect(JSON.stringify(stats)).not.toContain('org-a');

    const r = (await (await t.api('/ingest/events', { method: 'POST', json: [ev({ sessionId: 'plan-1', contextSize: 5000 })] })).json()) as {
      suggestions: { ruleId: string; severity: string; title: string }[];
    };
    const r10 = r.suggestions.find((s) => s.ruleId === 'R10') ?? (await waitFor(() => t.d.pipeline.visibleFor('plan-1')));
    expect(r10.ruleId).toBe('R10');
    expect(r10.severity).toBe('critical');
    // la config visible del usuario no cambia (el plan % es interno del motor)
    expect(t.d.config.plans).toEqual([]);
    await t.close();
  });

  it('sin archivo → no-data y sin planUsage', async () => {
    const t = await startTestDaemon();
    expect(t.d.health.get('claude-plan-usage')?.status).toBe('no-data');
    const stats = (await (await t.api('/stats')).json()) as { planUsage?: unknown };
    expect(stats.planUsage).toBeUndefined();
    await t.close();
  });
});

describe('statuslineText', () => {
  const view = {
    sessionId: 's', source: 'claude-code' as const, provider: 'anthropic' as const, client: 'cli', model: 'm', turns: 1,
    contextSize: 136_000, contextWindow: 200_000, contextPct: 0.68, cachePct: 0.91, estimated: false, lastTurnAt: '', status: 'active' as const,
  };
  const sug = {
    id: 'x', ruleId: 'R1', sessionId: 's', severity: 'warn' as const, title: 't', detail: 'd', expiresAt: '',
    actions: [{ kind: 'copy' as const, label: 'Copiar', payload: '/compact foco' }],
  };
  it('formato del SPEC, ≤ 80 columnas', () => {
    expect(statuslineText(view, sug, false)).toBe('ctx 68% · cache 91% · ⚠ /compact');
    expect(statuslineText(view, undefined, false)).toBe('ctx 68% · cache 91%');
    expect(statuslineText({ ...view, estimated: true, cachePct: null, contextPct: 0.45 }, undefined, false)).toBe('ctx ≈45%');
    expect(statuslineText(view, { ...sug, actions: [{ kind: 'handoff', label: 'x' }] }, false)).toBe('ctx 68% · cache 91% · ⚠ traspaso');
    expect(statuslineText(view, { ...sug, quiet: true }, false)).toBe('ctx 68% · cache 91%');
    expect(statuslineText(view, sug, true)).toBe('ContextPilot: sin datos');
    expect(statuslineText(undefined, undefined, false)).toBe('ContextPilot: sin datos');
    const long = statuslineText(view, { ...sug, actions: [{ kind: 'show-detail', label: 'x' }], title: 'x'.repeat(200) }, false);
    expect(long.length).toBeLessThanOrEqual(80);
  });
});
