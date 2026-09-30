import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexParser, codexSessionIdFromPath } from '@contextpilot/core';
import { coreFixture, rmrf, startTestDaemon, tempDir, waitFor, type TestDaemon } from './helpers.js';

// CP-031 (tailer Claude Code), CP-033 (Codex), CP-034 (Gemini CLI outfile + OTLP), CP-027 (health).

const open: TestDaemon[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  for (const d of dirs.splice(0)) rmrf(d);
});

async function daemon(over: Parameters<typeof startTestDaemon>[0] = {}) {
  const t = await startTestDaemon(over);
  open.push(t);
  return t;
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function userLine(sid: string, text: string, ts = iso()): string {
  return JSON.stringify({ type: 'user', sessionId: sid, version: '2.1.0', timestamp: ts, uuid: `u-${Math.random()}`, message: { role: 'user', content: text } }) + '\n';
}

function assistantLine(sid: string, id: string, usage: Record<string, number>, ts = iso(), extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'assistant',
      sessionId: sid,
      version: '2.1.0',
      timestamp: ts,
      uuid: `a-${Math.random()}`,
      message: { id, model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage },
      ...extra,
    }) + '\n'
  );
}

const U = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
});

describe('tailer de Claude Code', () => {
  it('sesión nueva en < 1 s, append incremental con línea partida, subagentes al padre', async () => {
    const t = await daemon();
    mkdirSync(t.dirs.claude, { recursive: true });
    await new Promise((r) => setTimeout(r, 300)); // el root aparece → attach (rootRetryMs=200)
    const proj = join(t.dirs.claude, 'C--repo');
    mkdirSync(proj, { recursive: true });
    const sid = '11111111-2222-3333-4444-555555555555';
    const file = join(proj, `${sid}.jsonl`);

    const t0 = Date.now();
    writeFileSync(file, userLine(sid, 'hola, arreglá el test del parser por favor'));
    const s = await waitFor(() => t.d.pipeline.getSession(sid));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.source).toBe('claude-code');

    // línea de assistant partida en dos escrituras
    const line = assistantLine(sid, 'msg_1', U(10, 5000, 1000, 50));
    appendFileSync(file, line.slice(0, 40));
    await new Promise((r) => setTimeout(r, 150));
    expect(t.d.pipeline.getSession(sid)?.calls).toBe(0);
    appendFileSync(file, line.slice(40));
    const s2 = await waitFor(() => (t.d.pipeline.getSession(sid)?.calls === 1 ? t.d.pipeline.getSession(sid) : undefined));
    expect(s2.totals).toMatchObject({ input: 10, cacheRead: 5000, cacheWrite: 1000, output: 50 });
    expect(s2.contextSize).toBe(6060);

    // mismo message.id repetido (un bloque por línea) → no duplica
    appendFileSync(file, assistantLine(sid, 'msg_1', U(10, 5000, 1000, 50)));
    appendFileSync(file, assistantLine(sid, 'msg_2', U(20, 6000, 0, 30)));
    const s3 = await waitFor(() => (t.d.pipeline.getSession(sid)?.calls === 2 ? t.d.pipeline.getSession(sid) : undefined));
    expect(s3.totals.input).toBe(30);

    // subagente: suma acumulados, no cambia el contexto del hilo principal
    const sub = join(proj, sid, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'agent-abc.jsonl'),
      JSON.stringify({ type: 'user', isSidechain: true, sessionId: sid, timestamp: iso(), message: { role: 'user', content: 'buscá X' } }) +
        '\n' +
        assistantLine(sid, 'msg_sub_1', U(100, 0, 2000, 70), iso(), { isSidechain: true }),
    );
    const s4 = await waitFor(() => {
      const x = t.d.pipeline.getSession(sid);
      return x && x.totals.input === 130 ? x : undefined;
    });
    expect(s4.contextSize).toBe(s3.contextSize);
    // el transcript registrado para el traspaso es el principal, no el del subagente
    expect(t.d.storage.getTranscript(sid)?.path).toBe(file);
  });

  it('reinicio: reanuda desde el offset persistido sin duplicar', async () => {
    const home = tempDir();
    const cli = tempDir();
    dirs.push(home, cli);
    const claude = join(cli, 'projects');
    const proj = join(claude, 'C--repo');
    mkdirSync(proj, { recursive: true });
    const sid = 'restart-session';
    const file = join(proj, `${sid}.jsonl`);
    writeFileSync(file, userLine(sid, 'primer prompt del usuario para la prueba') + assistantLine(sid, 'm1', U(1, 100, 0, 1)));

    const a = await startTestDaemon({ home, dirs: { claude } });
    await a.d.ready();
    await waitFor(() => a.d.pipeline.getSession(sid)?.calls === 1);
    await a.d.close();

    appendFileSync(file, assistantLine(sid, 'm2', U(2, 200, 0, 2)));
    const b = await startTestDaemon({ home, dirs: { claude } });
    open.push(b);
    await b.d.ready();
    const s = await waitFor(() => (b.d.pipeline.getSession(sid)?.calls === 2 ? b.d.pipeline.getSession(sid) : undefined));
    expect(s.totals.input).toBe(3);
    await new Promise((r) => setTimeout(r, 200));
    expect(b.d.pipeline.getSession(sid)?.calls).toBe(2);
  });

  it('arranque: transcripts viejos no se reprocesan (offset al final); recientes sí', async () => {
    const cli = tempDir();
    dirs.push(cli);
    const claude = join(cli, 'projects');
    const proj = join(claude, 'C--repo');
    mkdirSync(proj, { recursive: true });
    const oldFile = join(proj, 'old-session.jsonl');
    writeFileSync(oldFile, userLine('old-session', 'algo viejo de hace horas') + assistantLine('old-session', 'o1', U(5, 5, 5, 5), iso(-3 * 3_600_000)));
    const past = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(oldFile, past, past);
    const newFile = join(proj, 'recent-session.jsonl');
    writeFileSync(newFile, userLine('recent-session', 'algo reciente de recién') + assistantLine('recent-session', 'r1', U(7, 7, 7, 7)));

    const t = await daemon({ dirs: { claude } });
    await t.d.ready();
    expect(t.d.pipeline.getSession('recent-session')?.totals.input).toBe(7);
    expect(t.d.pipeline.getSession('old-session')).toBeUndefined();
    // un append posterior al viejo sí se procesa
    appendFileSync(oldFile, assistantLine('old-session', 'o2', U(9, 0, 0, 1)));
    const s = await waitFor(() => t.d.pipeline.getSession('old-session'));
    expect(s.totals.input).toBe(9);
  });

  it('directorio inexistente → no-data; líneas basura seguidas → error', async () => {
    const t = await daemon();
    const h = (await (await fetch(`${t.base}/health`)).json()) as { name: string; status: string }[];
    expect(h.find((x) => x.name === 'claude-code')?.status).toBe('no-data');
    expect(h.find((x) => x.name === 'codex')?.status).toBe('no-data');
    expect(h.find((x) => x.name === 'gemini-cli')?.status).toBe('no-data');

    const proj = join(t.dirs.claude, 'C--x');
    mkdirSync(proj, { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(proj, 'bad.jsonl'), '{no json\n{tampoco\n{ni este\n');
    await waitFor(() => t.d.health.get('claude-code')?.status === 'error');
    expect(await (await t.api('/statusline/bad')).text()).toBe('ContextPilot: sin datos');
  });
});

describe('Codex y Gemini CLI', () => {
  const CODEX = 'rollout-2026-09-29T10-00-00-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl';

  it('Codex: rollout nuevo bajo sessions/YYYY/MM/DD → eventos openai exactos', async () => {
    const t = await daemon();
    const day = join(t.dirs.codex, '2026', '09', '29');
    mkdirSync(day, { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(day, CODEX), coreFixture(`codex/${CODEX}`));
    // Oráculo: el parser del core aplicado sobre el fixture completo, sin tailer.
    const p = new CodexParser({ sessionId: codexSessionIdFromPath(CODEX) });
    const resp = coreFixture(`codex/${CODEX}`)
      .split('\n')
      .flatMap((l) => p.feed(l))
      .filter((e) => e.phase !== 'prompt');
    const sid = '5973b6c0-94b8-487b-a530-2aeb6098ae0e';
    const s = await waitFor(() => (t.d.pipeline.getSession(sid)?.calls === resp.length ? t.d.pipeline.getSession(sid) : undefined));
    expect(s.provider).toBe('openai');
    expect(s.totals.input).toBe(resp.reduce((a, e) => a + e.tokens.input, 0));
    expect(s.totals.output).toBe(resp.reduce((a, e) => a + e.tokens.output, 0));
    expect(t.d.health.get('codex')?.status).toBe('ok');
  });

  it('Gemini CLI: outfile escrito en dos partes (objeto partido) → mismos eventos que el fixture', async () => {
    const t = await daemon();
    mkdirSync(t.dirs.gemini, { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    const text = coreFixture('gemini-cli/telemetry.log');
    const outfile = join(t.dirs.gemini, 'telemetry.log');
    const cut = Math.floor(text.length / 2);
    writeFileSync(outfile, text.slice(0, cut));
    await new Promise((r) => setTimeout(r, 150));
    appendFileSync(outfile, text.slice(cut));
    const expected = JSON.parse(coreFixture('gemini-cli/telemetry.log.expected.json')) as { sessionId: string; phase?: string; tokens: { input: number } }[];
    const resp = expected.filter((e) => e.phase !== 'prompt');
    const sid = expected[0]!.sessionId;
    const s = await waitFor(() => (t.d.pipeline.getSession(sid)?.calls === resp.length ? t.d.pipeline.getSession(sid) : undefined));
    expect(s.totals.input).toBe(resp.reduce((a, e) => a + e.tokens.input, 0));
    expect(t.d.health.get('gemini-cli')?.status).toBe('ok');
  });

  it('POST /otlp/v1/logs (sin token) produce eventos', async () => {
    const t = await daemon();
    const body = coreFixture('gemini-cli/otlp-logs.json');
    const r = await fetch(`${t.base}/otlp/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
    await waitFor(() => t.d.pipeline.activeViews(Date.parse('2100-01-01')).length >= 0 && t.d.health.get('gemini-cli')?.status === 'ok');
  });
});
