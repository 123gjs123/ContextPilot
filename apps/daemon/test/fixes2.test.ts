import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleEngine, type Suggestion, type UsageWindow } from '@contextpilot/core';
import { defaultDaemonConfig, validateConfigPatch } from '../src/config.js';
import { HealthRegistry } from '../src/health.js';
import { nullLogger } from '../src/log.js';
import { Pipeline } from '../src/pipeline.js';
import { statuslineText } from '../src/server.js';
import { Storage } from '../src/storage.js';
import { ev, rmrf, startTestDaemon, tempDir, waitFor, wsClient, type TestDaemon } from './helpers.js';

// Defectos de la aceptación ronda 2 (docs/ACCEPTANCE.md §7.6) a nivel daemon: D-19, D-22, D-14, D-16.

const MIN = 60_000;
const open: TestDaemon[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  for (const d of dirs.splice(0)) rmrf(d);
});

/** Serie de plan-usage (en %) que agota la ventana de 5 h antes de su fin. */
function hot(now: number): UsageWindow {
  const pts = [10, 8, 8, 8, 8, 8, 8].map((tokens, i) => ({ ts: now - (6 - i) * 15 * MIN - MIN, tokens }));
  return { provider: 'anthropic', points: pts, byWindow: { '5h': pts, '168h': [{ ts: now - 2 * 86_400_000, tokens: 20 }] } };
}
function cold(now: number): UsageWindow {
  const pts = [10, 1, 0, 0, 0, 0, 0].map((tokens, i) => ({ ts: now - (6 - i) * 15 * MIN - MIN, tokens }));
  return { provider: 'anthropic', points: pts, byWindow: { '5h': pts, '168h': [{ ts: now - 2 * 86_400_000, tokens: 20 }] } };
}
const PERCENT = { provider: 'anthropic' as const, kind: 'subscription' as const, windows: [{ hours: 5, limit: 100 }, { days: 7, limit: 100 }] };

function planUsageFile(dir: string, fh: number[]): string {
  const now = Date.now();
  const file = join(dir, 'plan-usage-history.json');
  writeFileSync(file, JSON.stringify({ version: 2, samples: fh.map((v, i) => ({ t: now - (fh.length - 1 - i) * 15 * MIN - MIN, org: 'o', u: { fh: v, sd: 20 } })) }));
  return file;
}

function assistantLine(sid: string, id: string, ts: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      sessionId: sid,
      version: '2.1.284',
      timestamp: ts,
      uuid: `a-${id}`,
      message: {
        id,
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100, output_tokens: 50 },
      },
    }) + '\n'
  );
}

describe('pipeline con reloj simulado', () => {
  let storage: Storage;
  let pipe: Pipeline;
  let series: (now: number) => UsageWindow;
  const seen: { type: string; data: any }[] = [];

  beforeEach(async () => {
    storage = await Storage.open(null);
    vi.useFakeTimers({ now: new Date('2026-09-30T12:00:00Z') });
    const cfg = { ...defaultDaemonConfig(), plans: [PERCENT] };
    series = hot;
    pipe = new Pipeline(storage, new RuleEngine(cfg), new HealthRegistry(), () => cfg, nullLogger, {
      planUsage: () => series(Date.now()),
    });
    seen.length = 0;
    pipe.on('suggestion', (s) => seen.push({ type: 'suggestion', data: s }));
    pipe.on('cleared', (c) => seen.push({ type: 'cleared', data: c }));
  });
  afterEach(() => {
    pipe.dispose();
    vi.useRealTimers();
    storage.close();
  });

  it('D-19: el replay de arranque no publica ni fija el cooldown de R10; el primer evento en vivo la publica', () => {
    const old = new Date(Date.now() - 20 * MIN).toISOString();
    const r = pipe.ingest([ev({ sessionId: 'rp', ts: old })], { replay: true });
    expect(r.accepted).toBe(1);
    expect(r.suggestions).toEqual([]);
    expect(seen.filter((s) => s.type === 'suggestion')).toEqual([]);
    expect(pipe.getSession('rp')?.calls).toBe(1);
    const live = pipe.ingest([ev({ sessionId: 'rp', ts: new Date().toISOString() })]);
    expect(live.suggestions.map((s) => s.ruleId)).toEqual(['R10']);
    expect(live.suggestions[0]!.sessionId).toBe('account:anthropic');
    expect(storage.listSuggestions({}).filter((s) => s.ruleId === 'R10')).toHaveLength(1);
  });

  it('D-19: un evento de replay aún «vigente» tampoco se publica ni deja cooldown de R1 (el siguiente escalón en vivo avisa)', () => {
    const recent = new Date(Date.now() - 2 * MIN).toISOString();
    const r = pipe.ingest([ev({ sessionId: 'rp2', ts: recent, contextSize: 150_000 })], { replay: true });
    expect(r.suggestions).toEqual([]);
    // 75 % → 82 %: cruza el escalón de 80 %; con el cooldown de 20 min fijado en replay quedaba suprimida.
    const live = pipe.ingest([ev({ sessionId: 'rp2', contextSize: 164_000 })]);
    expect(live.suggestions.map((s) => s.ruleId)).toContain('R1');
  });

  it('D-22: sin eventos de sesión, evaluateAccounts publica R10; sigue visible mientras la condición se cumple y se retira al dejar de cumplirse', () => {
    const [s] = pipe.evaluateAccounts();
    expect(s).toMatchObject({ ruleId: 'R10', sessionId: 'account:anthropic', severity: 'critical' });
    // Antes: TTL 10 min. Ahora sigue visible (statusline `⏳ límite`) a los 11 y a los 59 min.
    vi.advanceTimersByTime(11 * MIN);
    expect(pipe.visibleFor('account:anthropic')?.id).toBe(s!.id);
    // El temporizador del daemon reevalúa cada 60 s: se renueva con el mismo id.
    for (let i = 0; i < 48; i++) {
      vi.advanceTimersByTime(MIN);
      pipe.evaluateAccounts();
    }
    expect(pipe.visibleFor('account:anthropic')?.id).toBe(s!.id);
    vi.advanceTimersByTime(30 * MIN);
    pipe.evaluateAccounts();
    expect(pipe.visibleFor('account:anthropic')?.id).toBe(s!.id);
    expect(Date.parse(storage.getSuggestion(s!.id)!.expiresAt)).toBeGreaterThan(Date.now() + 30 * MIN);
    expect(seen.filter((x) => x.type === 'cleared')).toEqual([]);
    // Una sola R10 (mismo id): las renovaciones no crean filas nuevas.
    expect(new Set(seen.filter((x) => x.type === 'suggestion').map((x) => x.data.id))).toEqual(new Set([s!.id]));
    expect(storage.listSuggestions({}).filter((x) => x.ruleId === 'R10')).toHaveLength(1);
    // La proyección deja de cumplirse → suggestion-cleared (expired) y fuera de /account.
    series = cold;
    pipe.evaluateAccounts();
    expect(seen.find((x) => x.type === 'cleared')?.data).toMatchObject({ id: s!.id, sessionId: 'account:anthropic', feedback: 'expired' });
    expect(pipe.accountSuggestions()).toEqual([]);
    expect(storage.getSuggestion(s!.id)?.status).toBe('expired');
  });

  it('D-22: reinicio del pipeline con R10 abierta: no se duplica', async () => {
    const [s] = pipe.evaluateAccounts();
    const cfg = { ...defaultDaemonConfig(), plans: [PERCENT] };
    const p2 = new Pipeline(storage, new RuleEngine(cfg), new HealthRegistry(), () => cfg, nullLogger, { planUsage: () => hot(Date.now()) });
    vi.advanceTimersByTime(MIN);
    expect(p2.evaluateAccounts()).toEqual([]);
    expect(p2.visibleFor('account:anthropic')?.id).toBe(s!.id);
    p2.dispose();
  });
});

describe('daemon aislado (home y proyectos temporales)', () => {
  it('D-19: transcript con un evento de hace 20 min re-procesado al arrancar → R10 visible y una sola fila', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const projects = join(dir, 'projects');
    const proj = join(projects, 'C--repo');
    mkdirSync(proj, { recursive: true });
    const sid = '11111111-2222-3333-4444-555555555555';
    const file = join(proj, `${sid}.jsonl`);
    writeFileSync(file, assistantLine(sid, 'msg_old', new Date(Date.now() - 20 * MIN).toISOString()));
    const t = await startTestDaemon({
      env: { ...process.env, CONTEXTPILOT_PLAN_USAGE_FILE: planUsageFile(dir, [10, 18, 26, 34, 42, 50, 58]) },
      dirs: { claude: projects },
    });
    open.push(t);
    await t.d.ready();
    const acc = await waitFor(async () => {
      const a = (await (await t.api('/account')).json()) as { suggestions: Suggestion[] };
      return a.suggestions.length ? a : null;
    });
    expect(acc.suggestions.map((s) => s.ruleId)).toEqual(['R10']);
    // La sesión se reconstruyó desde el replay.
    expect(t.d.pipeline.getSession(sid)?.calls).toBe(1);
    const line = await (await t.api(`/statusline/${sid}`)).text();
    expect(line).toMatch(/⏳ límite \d\d:\d\d$/);
    // El evento en vivo no duplica ni suprime: la R10 sigue siendo la misma.
    const c = await wsClient(t.base, t.token);
    await c.next((m) => m.type === 'hello');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, assistantLine(sid, 'msg_live', new Date().toISOString()));
    await waitFor(() => (t.d.pipeline.getSession(sid)?.calls ?? 0) >= 2);
    expect(t.d.pipeline.accountSuggestions().map((s) => s.id)).toEqual(acc.suggestions.map((s) => s.id));
    c.close();
  }, 20_000);

  it('D-22: R10 sin ninguna sesión (uso sólo en Desktop) y retiro al bajar el ritmo', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const file = planUsageFile(dir, [10, 18, 26, 34, 42, 50, 58]);
    const t = await startTestDaemon({ env: { ...process.env, CONTEXTPILOT_PLAN_USAGE_FILE: file }, accountEvalMs: 100 });
    open.push(t);
    const c = await wsClient(t.base, t.token);
    const hello = await c.next((m) => m.type === 'hello');
    const r10 =
      (hello.data.suggestions as Suggestion[]).find((s) => s.ruleId === 'R10') ??
      (await c.next((m) => m.type === 'suggestion' && m.data.ruleId === 'R10')).data;
    expect(r10.sessionId).toBe('account:anthropic');
    expect(t.d.pipeline.activeViews()).toEqual([]);
    // plan-usage nuevo con el ritmo plano → al detectar el cambio del archivo se retira.
    const cleared = c.next((m) => m.type === 'suggestion-cleared' && m.data.id === r10.id);
    planUsageFile(dir, [10, 11, 11, 11, 11, 11, 11]);
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    t.d.planUsage!.poll();
    expect((await cleared).data.feedback).toBe('expired');
    const acc = (await (await t.api('/account')).json()) as { suggestions: Suggestion[] };
    expect(acc.suggestions).toEqual([]);
    c.close();
  }, 20_000);

  it('D-14: PUT /config acepta modelTiers válidos y rechaza niveles desconocidos', async () => {
    expect(validateConfigPatch({ modelTiers: { 'mi-modelo': 'top' } })).toBeNull();
    expect(validateConfigPatch({ modelTiers: { 'mi-modelo': 'enorme' } })).toMatch(/modelTiers/);
    const t = await startTestDaemon();
    open.push(t);
    expect((await t.api('/config', { method: 'PUT', json: { modelTiers: { 'mi-modelo': 'huge' } } })).status).toBe(400);
    expect((await t.api('/config', { method: 'PUT', json: { modelTiers: { 'mi-modelo': 'top' } } })).status).toBe(200);
    expect(t.d.pipeline.engine.config.modelTiers).toEqual({ 'mi-modelo': 'top' });
    const r = (await (
      await t.api('/ingest/events', {
        method: 'POST',
        json: [ev({ sessionId: 'tier', model: 'mi-modelo', promptTokens: 40, tokens: { input: 40, output: 60, estimated: false } })],
      })
    ).json()) as { suggestions: Suggestion[] };
    expect(r.suggestions.map((s) => s.ruleId)).toContain('R7');
  });
});

describe('D-16: health del tailer de Claude Code ante formato desconocido', () => {
  it('versión desconocida → error con detalle, sin cifras; una llamada sin usage también', async () => {
    const t = await startTestDaemon();
    open.push(t);
    const proj = join(t.dirs.claude, 'C--x');
    mkdirSync(proj, { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    const sid = '22222222-2222-3333-4444-555555555555';
    const file = join(proj, `${sid}.jsonl`);
    writeFileSync(file, assistantLine(sid, 'm-ok', new Date().toISOString()));
    await waitFor(() => t.d.health.get('claude-code')?.status === 'ok');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, assistantLine(sid, 'm-v3', new Date().toISOString()).replace('"2.1.284"', '"3.0.0"'));
    const h = await waitFor(() => (t.d.health.get('claude-code')?.status === 'error' ? t.d.health.get('claude-code') : null));
    expect(h.detail).toMatch(/versión de formato desconocida: 3\.0\.0/);
    expect(h.formatVersion).toBe('3.0.0');
    // No se sumaron las cifras del registro de formato desconocido.
    expect(t.d.pipeline.getSession(sid)?.calls).toBe(1);
    const health = (await (await fetch(`${t.base}/health`)).json()) as { name: string; status: string; detail?: string }[];
    expect(health.find((x) => x.name === 'claude-code')).toMatchObject({ status: 'error' });

    // Otra sesión: llamada sin message.usage → error con detalle de campos faltantes.
    const sid2 = '33333333-2222-3333-4444-555555555555';
    const broken = JSON.parse(assistantLine(sid2, 'm-x', new Date().toISOString()));
    delete broken.message.usage;
    appendFileSync(join(proj, `${sid2}.jsonl`), JSON.stringify(broken) + '\n');
    await waitFor(() => /message\.usage/.test(t.d.health.get('claude-code')?.detail ?? ''));
    expect(t.d.pipeline.getSession(sid2)).toBeUndefined();
  }, 20_000);
});

describe('statusline con R10 de cuenta', () => {
  it('muestra ⏳ límite mientras la sugerencia de cuenta esté vigente', () => {
    const view = {
      sessionId: 's', source: 'claude-code' as const, provider: 'anthropic' as const, client: 'cli', model: 'm', turns: 1,
      contextSize: 10_000, contextWindow: 200_000, contextPct: 0.05, cachePct: 0.9, estimated: false, lastTurnAt: '', status: 'active' as const,
    };
    const acc = { id: 'a', ruleId: 'R10', sessionId: 'account:anthropic', severity: 'critical' as const, title: 'A este ritmo llegás al límite a las 13:14', detail: '', actions: [], expiresAt: '' };
    expect(statuslineText(view, undefined, false, acc)).toMatch(/⏳ límite 13:14$/);
  });
});
