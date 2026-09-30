import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreFixture, rmrf, startTestDaemon, tempDir, waitFor, type TestDaemon } from './helpers.js';

// D-10 (CP-035.1/.3/.4, CP-036.2): proxy OpenAI y Google de punta a punta, fuga de las 3 formas de
// credencial (Authorization, x-api-key, x-goog-api-key y ?key=), salida por HTTP(S)_PROXY y
// extractor que lanza sin romper el pass-through.

const KEYS = {
  openai: 'sk-proj-FAKEOPENAIKEY-no-debe-persistir-9f8e7d6c5b4a',
  anthropic: 'sk-ant-api03-FAKEANTHROPIC-no-debe-persistir-1a2b3c',
  googleHeader: 'AIzaFAKEGOOGLEHEADER-no-debe-persistir-77',
  googleQuery: 'AIzaFAKEGOOGLEQUERY-no-debe-persistir-88',
};
const OPENAI_SSE = coreFixture('proxy/openai-chat.sse');
const GEMINI_SSE = coreFixture('proxy/gemini-stream.sse');
const ANTHROPIC_SSE = coreFixture('proxy/anthropic-messages.sse');

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function fakeUpstream(seen: Seen[]): Server {
  return createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      seen.push({ url: req.url!, headers: req.headers, body: Buffer.concat(parts) });
      const url = req.url!;
      const sse = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // en 3 pedazos para ejercitar el tee con chunks partidos
        const b = Buffer.from(body);
        const n = Math.ceil(b.length / 3);
        for (let i = 0; i < b.length; i += n) res.write(b.subarray(i, i + n));
        res.end();
      };
      if (url.includes('/chat/completions')) sse(OPENAI_SSE);
      else if (url.includes(':streamGenerateContent')) sse(GEMINI_SSE);
      else if (url.includes('/v1/messages')) sse(ANTHROPIC_SSE);
      else res.writeHead(404).end();
    });
  });
}

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
}

async function close(s: Server): Promise<void> {
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const OPENAI_REQ = JSON.stringify({
  model: 'gpt-4.1',
  stream: true,
  stream_options: { include_usage: true },
  messages: [
    { role: 'system', content: 'reglas de prueba' },
    { role: 'user', content: 'buscá el clima' },
    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'soleado' },
  ],
  tools: [
    { type: 'function', function: { name: 'get_weather', description: 'clima', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'never_used', description: 'x'.repeat(400), parameters: { type: 'object' } } },
  ],
});

const GEMINI_REQ = JSON.stringify({
  systemInstruction: { parts: [{ text: 'reglas' }] },
  contents: [{ role: 'user', parts: [{ text: 'calculá 6 × 7' }] }],
});

describe('proxy OpenAI y Google de punta a punta (D-10)', () => {
  const seen: Seen[] = [];
  let up: Server;
  let t: TestDaemon;
  beforeAll(async () => {
    up = fakeUpstream(seen);
    const base = await listen(up);
    // quiet:false → el daemon escribe su log en el home: también se revisa por fugas.
    t = await startTestDaemon({ upstreams: { anthropic: base, openai: base, google: base }, quiet: false });
  });
  afterAll(async () => {
    await t.close();
    await close(up);
  });

  it('OpenAI Chat Completions: bytes idénticos, Authorization reenviado, uso exacto, tools para R6', async () => {
    const r = await post(`${t.base}/proxy/openai/v1/chat/completions`, OPENAI_REQ, { authorization: `Bearer ${KEYS.openai}`, 'x-cp-session': 'oa-1' });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe(OPENAI_SSE);
    const out = seen.find((s) => s.url === '/v1/chat/completions')!;
    expect(out.headers.authorization).toBe(`Bearer ${KEYS.openai}`);
    expect(out.headers['x-cp-session']).toBeUndefined();
    expect(out.body.toString()).toBe(OPENAI_REQ);
    const s = await waitFor(() => t.d.pipeline.getSession('oa-1'));
    expect(s.provider).toBe('openai');
    expect(s.totals).toMatchObject({ input: 2150 - 1920, cacheRead: 1920, output: 3 });
    expect(s.toolsAvailable.map((x) => x.name)).toEqual(['get_weather', 'never_used']);
    // D-4: la herramienta invocada en el historial cuenta como usada.
    expect(s.toolLastUsedTurn.get_weather).toBeDefined();
    expect(s.toolLastUsedTurn.never_used).toBeUndefined();
  });

  it('Google streamGenerateContent: x-goog-api-key y ?key= reenviados sin tocar, uso exacto', async () => {
    const path = `/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${KEYS.googleQuery}`;
    const r = await post(`${t.base}/proxy/google${path}`, GEMINI_REQ, { 'x-goog-api-key': KEYS.googleHeader, 'x-cp-session': 'g-1' });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe(GEMINI_SSE);
    const out = seen.find((s) => s.url.includes(':streamGenerateContent'))!;
    expect(out.url).toBe(path);
    expect(out.headers['x-goog-api-key']).toBe(KEYS.googleHeader);
    const s = await waitFor(() => t.d.pipeline.getSession('g-1'));
    expect(s.provider).toBe('google');
    expect(s.model).toBe('gemini-2.5-flash');
    expect(s.totals).toMatchObject({ input: 9800 - 8192, cacheRead: 8192, output: 7, reasoning: 150 });
  });

  it('Anthropic con x-api-key; upstream caído (log de error) → 502', async () => {
    const r = await post(`${t.base}/proxy/anthropic/v1/messages`, JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hola' }] }), {
      'x-api-key': KEYS.anthropic,
    });
    expect(r.status).toBe(200);
    const dead = await startTestDaemon({ upstreams: { anthropic: 'http://127.0.0.1:1', openai: 'http://127.0.0.1:1', google: 'http://127.0.0.1:1' }, quiet: false, home: t.home + '-dead' });
    for (const [prov, h] of [
      ['anthropic', { 'x-api-key': KEYS.anthropic }],
      ['openai', { authorization: `Bearer ${KEYS.openai}` }],
      ['google', { 'x-goog-api-key': KEYS.googleHeader }],
    ] as const) {
      expect((await post(`${dead.base}/proxy/${prov}/v1/x?key=${KEYS.googleQuery}`, '{}', { ...h })).status).toBe(502);
    }
    await dead.close();
    // Revisión de fuga también en el home del daemon con upstream caído.
    for (const f of walk(t.home + '-dead')) for (const k of Object.values(KEYS)) expect(readFileSync(f).includes(k), `${f} contiene ${k.slice(0, 12)}`).toBe(false);
    rmrf(t.home + '-dead');
  });

  it('RNF-04: ninguna credencial (Authorization / x-api-key / x-goog-api-key / ?key=) en cp.db, logs ni archivos', () => {
    t.d.storage.flush();
    const files = walk(t.home);
    expect(files.some((f) => f.includes('logs'))).toBe(true);
    for (const f of files) {
      const buf = readFileSync(f);
      for (const k of Object.values(KEYS)) expect(buf.includes(k), `${f} contiene ${k.slice(0, 12)}`).toBe(false);
      expect(buf.includes('FAKE'), f).toBe(false);
    }
  });
});

describe('extractor que lanza (CP-036.2)', () => {
  it('la respuesta al cliente es idéntica y health proxy = error', async () => {
    const seen: Seen[] = [];
    const up = fakeUpstream(seen);
    const base = await listen(up);
    const t = await startTestDaemon({
      upstreams: { anthropic: base, openai: base, google: base },
      proxyExtractorFor: () => ({
        push() {
          throw new Error('extractor roto a propósito');
        },
        end() {
          throw new Error('extractor roto a propósito');
        },
      }),
    });
    const r = await post(`${t.base}/proxy/openai/v1/chat/completions`, OPENAI_REQ, { 'x-cp-session': 'broken-1' });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe(OPENAI_SSE);
    await waitFor(() => t.d.health.get('proxy')?.status === 'error');
    expect(t.d.health.get('proxy')?.detail).toContain('extractor');
    expect(t.d.pipeline.getSession('broken-1')).toBeUndefined();
    // Un segundo pedido sigue pasando.
    expect((await post(`${t.base}/proxy/openai/v1/chat/completions`, OPENAI_REQ)).body.toString()).toBe(OPENAI_SSE);
    await t.close();
    await close(up);
  });
});

describe('salida por el proxy corporativo (CP-035.4)', () => {
  /** Proxy de reenvío mínimo: absolute-form (HTTP) y CONNECT (HTTPS), todo hacia el upstream local. */
  function corporateProxy(target: string, log: string[]): Server {
    const t = new URL(target);
    const s = createServer((req, res) => {
      log.push(`${req.method} ${req.url}`);
      const u = new URL(req.url!);
      const fwd = httpRequest({ host: t.hostname, port: t.port, method: req.method, path: u.pathname + u.search, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode!, r.headers);
        r.pipe(res);
      });
      req.pipe(fwd);
    });
    s.on('connect', (req, socket: Socket, head) => {
      log.push(`CONNECT ${req.url}`);
      if (req.url!.startsWith('https-target.invalid')) {
        // HTTPS: sólo se verifica que el túnel se pidió al proxy corporativo.
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const up = connect(Number(t.port), t.hostname, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
    });
    return s;
  }

  it('HTTP_PROXY / HTTPS_PROXY del entorno del daemon se usan para upstreams no locales', async () => {
    const seen: Seen[] = [];
    const up = fakeUpstream(seen);
    const upBase = await listen(up);
    const log: string[] = [];
    const corp = corporateProxy(upBase, log);
    const corpBase = await listen(corp);
    const scratch = tempDir();
    const env: NodeJS.ProcessEnv = { ...process.env, HTTP_PROXY: corpBase, HTTPS_PROXY: corpBase, NO_PROXY: '', CONTEXTPILOT_PLAN_USAGE_FILE: join(scratch, 'none.json') };
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.no_proxy;
    const t = await startTestDaemon({
      env,
      upstreams: { anthropic: 'https://https-target.invalid', openai: 'http://http-target.invalid', google: 'http://http-target.invalid' },
    });
    // HTTP: pasa por el proxy corporativo y llega al upstream con bytes idénticos.
    const r = await post(`${t.base}/proxy/openai/v1/chat/completions`, OPENAI_REQ, { 'x-cp-session': 'corp-1' });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe(OPENAI_SSE);
    expect(log.some((l) => l.includes('http-target.invalid'))).toBe(true);
    // HTTPS: el daemon pide el túnel CONNECT al proxy corporativo (que acá lo rechaza → 502).
    const r2 = await post(`${t.base}/proxy/anthropic/v1/messages`, '{}');
    expect(r2.status).toBe(502);
    expect(log.some((l) => l.startsWith('CONNECT https-target.invalid'))).toBe(true);
    await t.close();
    await close(corp);
    await close(up);
    rmrf(scratch);
  });
});
