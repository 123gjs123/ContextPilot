import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleEngine } from '@contextpilot/core';
import { defaultDaemonConfig } from '../src/config.js';
import { HealthRegistry } from '../src/health.js';
import { nullLogger } from '../src/log.js';
import { Pipeline } from '../src/pipeline.js';
import { Storage } from '../src/storage.js';
import { ev, startTestDaemon, wsClient } from './helpers.js';

// CP-024 (pipeline, < 1 s), CP-026 (feedback), R2 proactivo (DECISIONS), vencimiento de sugerencias.

describe('pipeline end-to-end por HTTP + WS', () => {
  it('POST /ingest/events que cruza R1 → sugerencia por WS en < 1 s (p95 sobre 50)', async () => {
    const t = await startTestDaemon();
    const c = await wsClient(t.base, t.token);
    const hello = await c.next((m) => m.type === 'hello');
    expect(hello.data.version).toBe('0.1.0');
    const lat: number[] = [];
    for (let i = 0; i < 50; i++) {
      const sid = `R1-${i}`;
      const t0 = performance.now();
      const p = c.next((m) => m.type === 'suggestion' && m.data.sessionId === sid);
      await t.api('/ingest/events', {
        method: 'POST',
        json: [ev({ sessionId: sid, contextSize: 150_000, tokens: { input: 100, output: 100, cacheRead: 140_000, cacheWrite: 0, estimated: false } })],
      });
      const m = await p;
      lat.push(performance.now() - t0);
      expect(m.data.ruleId).toBe('R1');
    }
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)]!;
    console.log(`latencia evento→WS p95=${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(1000);

    // session + statusline con ⚠
    expect(c.msgs.some((m) => m.type === 'session' && m.data.sessionId === 'R1-0')).toBe(true);
    expect(await (await t.api('/statusline/R1-0')).text()).toBe('ctx 75% · cache 100% · ⚠ /compact');

    // 3 clientes reciben la misma sugerencia (CP-026.2)
    const c2 = await wsClient(t.base, t.token);
    const c3 = await wsClient(t.base, t.token);
    const got = [c, c2, c3].map((x) => x.next((m) => m.type === 'suggestion' && m.data.sessionId === 'multi'));
    await t.api('/ingest/events', { method: 'POST', json: [ev({ sessionId: 'multi', contextSize: 150_000 })] });
    const ids = (await Promise.all(got)).map((m) => m.data.id);
    expect(new Set(ids).size).toBe(1);

    // feedback → suggestion-cleared + persistido; racha de descartes persiste
    const sid = ids[0];
    const cleared = c.next((m) => m.type === 'suggestion-cleared' && m.data.id === sid);
    const r = await t.api(`/suggestions/${sid}/feedback`, { method: 'POST', json: { feedback: 'dismissed' }, headers: { 'x-cp-surface': 'tray' } });
    expect(r.status).toBe(200);
    expect((await cleared).data.feedback).toBe('dismissed');
    const list = (await (await t.api('/suggestions?sessionId=multi')).json()) as { id: string; feedback?: string }[];
    expect(list.find((s) => s.id === sid)?.feedback).toBe('dismissed');
    expect((await (await t.api('/suggestions?sessionId=multi&active=true')).json()) as unknown[]).toHaveLength(0);
    expect(t.d.storage.getSetting<Record<string, number>>('dismissStreaks')?.R1).toBe(1);

    // feedback por WS (equivalente al POST)
    const s0 = c.msgs.find((m) => m.type === 'suggestion' && m.data.sessionId === 'R1-1').data.id;
    const cl2 = c.next((m) => m.type === 'suggestion-cleared' && m.data.id === s0);
    c.ws.send(JSON.stringify({ type: 'feedback', data: { id: s0, feedback: 'accepted' } }));
    expect((await cl2).data.feedback).toBe('accepted');

    for (const x of [c, c2, c3]) x.close();
    await t.close();
  }, 30_000);

  it('rachas de descarte sobreviven a un reinicio', async () => {
    const t = await startTestDaemon();
    const home = t.home;
    t.d.storage.setSetting('dismissStreaks', { R5: 4 });
    t.d.storage.flush();
    await t.d.close();
    const t2 = await startTestDaemon({ home });
    expect(t2.d.pipeline.engine.getDismissStreaks().R5).toBe(4);
    await t2.close();
  });
});

describe('temporizadores (fake timers)', () => {
  let storage: Storage;
  let pipe: Pipeline;
  const seen: { type: string; data: any }[] = [];

  beforeEach(async () => {
    storage = await Storage.open(null);
    vi.useFakeTimers({ now: new Date('2026-09-30T12:00:00Z') });
    const cfg = defaultDaemonConfig();
    pipe = new Pipeline(storage, new RuleEngine(cfg), new HealthRegistry(), () => cfg, nullLogger);
    seen.length = 0;
    pipe.on('suggestion', (s) => seen.push({ type: 'suggestion', data: s }));
    pipe.on('cleared', (c) => seen.push({ type: 'cleared', data: c }));
  });
  afterEach(() => {
    pipe.dispose();
    vi.useRealTimers();
    storage.close();
  });

  const big = () =>
    ev({
      sessionId: 'P',
      ts: new Date().toISOString(),
      contextSize: 120_000,
      tokens: { input: 10, output: 200, cacheRead: 110_000, cacheWrite: 9_000, estimated: false },
      cacheTtlMs: 5 * 60_000,
    });

  it('R2 proactivo: al cruzar el TTL sin actividad publica la sugerencia una sola vez', () => {
    pipe.ingest([big()]);
    expect(seen.filter((s) => s.data.ruleId === 'R2')).toHaveLength(0);
    vi.advanceTimersByTime(5 * 60_000 - 1000);
    expect(seen.filter((s) => s.data.ruleId === 'R2')).toHaveLength(0);
    vi.advanceTimersByTime(3000);
    const r2 = seen.filter((s) => s.type === 'suggestion' && s.data.ruleId === 'R2');
    expect(r2).toHaveLength(1);
    expect(r2[0]!.data.title).toMatch(/caché expiró/);
    vi.advanceTimersByTime(60 * 60_000);
    expect(seen.filter((s) => s.type === 'suggestion' && s.data.ruleId === 'R2')).toHaveLength(1);
  });

  it('R2 proactivo: actividad antes del TTL reprograma; contexto chico no programa', () => {
    pipe.ingest([big()]);
    vi.advanceTimersByTime(4 * 60_000);
    pipe.ingest([{ ...big(), id: 'second', ts: new Date().toISOString() }]);
    vi.advanceTimersByTime(2 * 60_000);
    expect(seen.filter((s) => s.data.ruleId === 'R2')).toHaveLength(0);
    vi.advanceTimersByTime(4 * 60_000);
    expect(seen.filter((s) => s.type === 'suggestion' && s.data.ruleId === 'R2')).toHaveLength(1);

    pipe.ingest([ev({ sessionId: 'small', ts: new Date().toISOString(), contextSize: 10_000 })]);
    vi.advanceTimersByTime(30 * 60_000);
    expect(seen.some((s) => s.data.sessionId === 'small' && s.data.ruleId === 'R2')).toBe(false);
  });

  it('una sugerencia sin feedback vence → suggestion-cleared expired', () => {
    // tokens estimados: R2 (exige exacto) no la reemplaza antes de vencer
    pipe.ingest([ev({ sessionId: 'X', ts: new Date().toISOString(), contextSize: 150_000, tokens: { input: 150_000, output: 10, estimated: true } })]);
    const s = seen.find((x) => x.type === 'suggestion')!.data;
    vi.advanceTimersByTime(10 * 60_000 + 10);
    const cl = seen.find((x) => x.type === 'cleared' && x.data.id === s.id);
    expect(cl?.data.feedback).toBe('expired');
    expect(storage.getSuggestion(s.id)?.status).toBe('expired');
  });

  it('replay: sugerencias de eventos viejos no se publican', () => {
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const r = pipe.ingest([ev({ sessionId: 'old', ts: old, contextSize: 150_000 })], { replay: true });
    expect(r.accepted).toBe(1);
    expect(r.suggestions).toHaveLength(0);
    expect(pipe.getSession('old')?.contextSize).toBe(150_000);
  });

  it('contenido opt-in: sólo se guarda con storeContent de la fuente', () => {
    pipe.ingest([{ ...ev({ sessionId: 'C', ts: new Date().toISOString() }), content: 'SECRETO-DE-CONTENIDO-123' }]);
    expect(Buffer.from(storage.exportBytes()).includes('SECRETO-DE-CONTENIDO-123')).toBe(false);
  });
});
