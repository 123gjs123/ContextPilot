import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ev, startTestDaemon, tempDir, rmrf, type TestDaemon } from './helpers.js';

// CP-022, CP-025, CP-026, CP-027, CP-054..CP-057: superficie HTTP/WS según docs/API.md.

let t: TestDaemon;
beforeAll(async () => {
  t = await startTestDaemon();
});
afterAll(async () => {
  await t.close();
});

describe('superficie de red y auth (CP-022)', () => {
  it('escucha sólo en 127.0.0.1', () => {
    const addr = t.d.server.address() as { address: string };
    expect(addr.address).toBe('127.0.0.1');
  });

  it('token de 32 bytes hex persistido en el home y reutilizado al reiniciar', async () => {
    const onDisk = readFileSync(join(t.home, 'token'), 'utf8').trim();
    expect(onDisk).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk).toBe(t.token);
    const home = tempDir();
    const a = await startTestDaemon({ home });
    const tok = a.token;
    await a.close();
    const b = await startTestDaemon({ home });
    expect(b.token).toBe(tok);
    await b.close();
    rmrf(home);
  });

  it('sin token → 401 sin cuerpo; /health no exige token', async () => {
    const r = await fetch(`${t.base}/sessions`);
    expect(r.status).toBe(401);
    expect(await r.text()).toBe('');
    const bad = await fetch(`${t.base}/sessions`, { headers: { 'x-cp-token': 'x'.repeat(64) } });
    expect(bad.status).toBe(401);
    const h = await fetch(`${t.base}/health`);
    expect(h.status).toBe(200);
    const list = (await h.json()) as { name: string; status: string }[];
    expect(list.map((x) => x.name)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'gemini-cli', 'proxy', 'hooks', 'env']));
  });

  it('Origin ajeno → 403; chrome-extension:// y file:// (null) aceptados con CORS', async () => {
    const evil = await t.api('/sessions', { headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    const evilHealth = await fetch(`${t.base}/health`, { headers: { origin: 'http://localhost:3000' } });
    expect(evilHealth.status).toBe(403);
    const ext = await t.api('/sessions', { headers: { origin: 'chrome-extension://abcdefghijklmnop' } });
    expect(ext.status).toBe(200);
    expect(ext.headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdefghijklmnop');
    const file = await t.api('/sessions', { headers: { origin: 'null' } });
    expect(file.status).toBe(200);
    const pre = await fetch(`${t.base}/sessions`, { method: 'OPTIONS', headers: { origin: 'chrome-extension://abc' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-cp-token');
  });
});

describe('ingesta y consultas (CP-024, CP-025)', () => {
  it('eventos inválidos → 400 con índice y campo', async () => {
    const bad = { ...ev(), sessionId: undefined };
    const r = await t.api('/ingest/events', { method: 'POST', json: [ev({ sessionId: 'ok-1' }), bad] });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { index: number; field: string };
    expect(body.index).toBe(1);
    expect(body.field).toBe('sessionId');
    const noEst = ev();
    delete (noEst.tokens as { estimated?: boolean }).estimated;
    const r2 = await t.api('/ingest/events', { method: 'POST', json: [noEst] });
    expect(((await r2.json()) as { field: string }).field).toBe('tokens.estimated');
  });

  it('eventos válidos → 202 {accepted, suggestions}; id/ts se completan; idempotente por id', async () => {
    const e = ev({ sessionId: 'Q1' }) as Partial<ReturnType<typeof ev>>;
    delete e.id;
    delete e.ts;
    const r = await t.api('/ingest/events', { method: 'POST', json: [e] });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { accepted: number; suggestions: unknown[] };
    expect(body.accepted).toBe(1);
    expect(Array.isArray(body.suggestions)).toBe(true);
    const fixed = ev({ id: 'FIXED-ID-1', sessionId: 'Q1' });
    await t.api('/ingest/events', { method: 'POST', json: [fixed] });
    const again = await t.api('/ingest/events', { method: 'POST', json: [fixed] });
    expect(((await again.json()) as { accepted: number }).accepted).toBe(0);
  });

  it('GET /sessions?active=true, /sessions/:id con timeline y 404', async () => {
    await t.api('/ingest/events', {
      method: 'POST',
      json: [ev({ sessionId: 'Q2', contextSize: 50_000, tokens: { input: 10, output: 5, cacheRead: 45_000, cacheWrite: 1000, estimated: false } })],
    });
    const list = (await (await t.api('/sessions?active=true')).json()) as { sessionId: string; contextPct: number }[];
    const q2 = list.find((s) => s.sessionId === 'Q2');
    expect(q2?.contextPct).toBeCloseTo(0.25);
    const one = (await (await t.api('/sessions/Q2')).json()) as { view: { sessionId: string }; timeline: { contextSize: number; cacheRatio: number }[]; suggestions: unknown[] };
    expect(one.view.sessionId).toBe('Q2');
    expect(one.timeline.at(-1)?.contextSize).toBe(50_000);
    expect(one.timeline.at(-1)?.cacheRatio).toBeCloseTo(45_000 / 46_010);
    expect((await t.api('/sessions/nope')).status).toBe(404);
  });

  it('statusline: sesión desconocida → «ContextPilot: sin datos»; conocida → ctx y cache', async () => {
    const unknown = await t.api('/statusline/nada');
    expect(unknown.headers.get('content-type')).toContain('text/plain');
    expect(await unknown.text()).toBe('ContextPilot: sin datos');
    const t0 = performance.now();
    const line = await (await t.api('/statusline/Q2')).text();
    expect(performance.now() - t0).toBeLessThan(50);
    expect(line).toBe('ctx 25% · cache 98%');
  });

  it('statusline con cifras estimadas usa ≈', async () => {
    await t.api('/ingest/events', {
      method: 'POST',
      json: [ev({ sessionId: 'claude.ai:abc', source: 'web', client: 'claude.ai', contextSize: 90_000, tokens: { input: 90_000, output: 10, estimated: true } })],
    });
    expect(await (await t.api('/statusline/claude.ai%3Aabc')).text()).toMatch(/^ctx ≈45%/);
  });
});

describe('feedback y WS (CP-026)', () => {
  it('feedback inválido → 400, id inexistente → 404', async () => {
    expect((await t.api('/suggestions/x/feedback', { method: 'POST', json: { feedback: 'meh' } })).status).toBe(400);
    expect((await t.api('/suggestions/x/feedback', { method: 'POST', json: { feedback: 'accepted' } })).status).toBe(404);
  });

  it('WS con token inválido se cierra con 4401', async () => {
    const ws = new WebSocket(`${t.base.replace('http', 'ws')}/stream?token=bad`);
    const code = await new Promise<number>((res) => ws.on('close', (c) => res(c)));
    expect(code).toBe(4401);
  });

  it('WS con Origin ajeno → 403 en el upgrade', async () => {
    const ws = new WebSocket(`${t.base.replace('http', 'ws')}/stream?token=${t.token}`, { headers: { origin: 'https://evil.example' } });
    const err = await new Promise<Error>((res) => ws.on('error', res));
    expect(String(err.message)).toContain('403');
  });
});

describe('config, stats, equipo (CP-054..CP-057)', () => {
  it('GET/PUT /config valida y aplica en caliente', async () => {
    const cfg = (await (await t.api('/config')).json()) as { rules: Record<string, { enabled: boolean }>; storeContent: Record<string, boolean> };
    expect(cfg.rules.R1?.enabled).toBe(true);
    expect(Object.values(cfg.storeContent).every((v) => v === false)).toBe(true);
    const bad = await t.api('/config', { method: 'PUT', json: { rules: { R1: { enabled: 'si' } } } });
    expect(bad.status).toBe(400);
    const ok = await t.api('/config', { method: 'PUT', json: { rules: { R1: { thresholds: { pct: 0.7 } } } } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).rules.R1.thresholds.pct).toBe(0.7);
    expect(t.d.pipeline.engine.config.rules.R1?.thresholds.pct).toBe(0.7);
    const onDisk = JSON.parse(readFileSync(join(t.home, 'config.json'), 'utf8'));
    expect(onDisk.rules.R1.thresholds.pct).toBe(0.7);
    await t.api('/config', { method: 'PUT', json: { rules: { R1: { thresholds: { pct: 0.6 } } } } });
  });

  it('adaptador deshabilitado → health disabled; rehabilitado vuelve', async () => {
    await t.api('/config', { method: 'PUT', json: { adapters: { codex: { enabled: false } } } });
    let h = (await (await fetch(`${t.base}/health`)).json()) as { name: string; status: string }[];
    expect(h.find((x) => x.name === 'codex')?.status).toBe('disabled');
    await t.api('/config', { method: 'PUT', json: { adapters: { codex: { enabled: true } } } });
    h = (await (await fetch(`${t.base}/health`)).json()) as { name: string; status: string }[];
    expect(h.find((x) => x.name === 'codex')?.status).not.toBe('disabled');
  });

  it('plan inválido → 400 (CP-055)', async () => {
    const r = await t.api('/config', { method: 'PUT', json: { plans: [{ provider: 'anthropic', kind: 'subscription' }] } });
    expect(r.status).toBe(400);
  });

  it('export sin token local; import dryRun no aplica', async () => {
    const r = await t.api('/config/export');
    expect(r.headers.get('content-disposition')).toContain('attachment');
    const text = await r.text();
    expect(text).not.toContain(t.token);
    const cfg = JSON.parse(text);
    expect(cfg.schemaVersion).toBe(1);
    cfg.rules.R5.enabled = false;
    const dry = (await (await t.api('/config/import?dryRun=true', { method: 'POST', json: cfg })).json()) as any;
    expect(dry.rules.R5.enabled).toBe(false);
    expect(t.d.config.rules.R5?.enabled).toBe(true);
    const applied = await t.api('/config/import', { method: 'POST', json: cfg });
    expect(applied.status).toBe(200);
    expect(t.d.config.rules.R5?.enabled).toBe(false);
    cfg.rules.R5.enabled = true;
    await t.api('/config/import', { method: 'POST', json: cfg });
  });

  it('GET /stats devuelve la forma del contrato', async () => {
    const s = (await (await t.api('/stats')).json()) as Record<string, unknown>;
    expect(s).toHaveProperty('byRule');
    expect(s).toHaveProperty('byProvider');
    expect(s).toHaveProperty('acceptanceRate');
    expect(s).toHaveProperty('suggestionsPerActiveHour');
    const prov = (s.byProvider as { provider: string; input: number }[]).find((p) => p.provider === 'anthropic');
    expect(prov?.input).toBeGreaterThan(0);
  });

  it('GET /team/export: sin ids, hashes ni rutas', async () => {
    const r = await t.api('/team/export');
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toMatch(/Q1|Q2|claude\.ai:abc/);
    expect(text).not.toMatch(/[0-9a-f]{16,}/i);
    expect(text).not.toMatch(/[A-Z]:\\\\/);
    expect(JSON.parse(text).schema).toBe('contextpilot.team/1');
  });

  it('ruta desconocida → 404', async () => {
    expect((await t.api('/nope')).status).toBe(404);
  });
});
