import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreFixture, spawnDaemon, startTestDaemon, waitFor, type TestDaemon } from './helpers.js';

// CP-035 / CP-036 / CP-058 (guarda de cumplimiento): el proxy entrega byte a byte lo que manda el
// upstream, no altera el pedido saliente, agrega < 5 ms y extrae el uso de una copia del stream.

const API_KEY = 'sk-ant-api03-FAKE-KEY-que-no-debe-quedar-en-disco-0123456789';
const SSE = coreFixture('proxy/anthropic-messages.sse');
const CHUNKS = 50;
const GAP_MS = 20;

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let upstream: Server;
let upBase = '';
const seen: Seen[] = [];
/** Momento (performance.now) en que el upstream escribió cada chunk, por x-run-id. */
const sentAt = new Map<string, number[]>();
let t: TestDaemon;

function chunksOf(buf: Buffer, n: number): Buffer[] {
  const size = Math.ceil(buf.length / n);
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', async () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(parts) });
      if (req.url!.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'si', 'set-cookie': ['a=1', 'b=2'], 'request-id': 'req_123' });
        const gap = req.url!.includes('fast') ? 0 : GAP_MS;
        const log: number[] = [];
        sentAt.set(String(req.headers['x-run-id'] ?? ''), log);
        for (const c of chunksOf(Buffer.from(SSE), CHUNKS)) {
          log.push(performance.now());
          res.write(c);
          if (gap) await new Promise((r) => setTimeout(r, gap));
        }
        res.end();
      } else if (req.url!.startsWith('/v1/json-gzip')) {
        const body = gzipSync(
          JSON.stringify({
            id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hola' }],
            usage: { input_tokens: 21, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, output_tokens: 9 },
          }),
        );
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length) });
        res.end(body);
      } else if (req.url!.startsWith('/v1/limit')) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
        res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  t = await startTestDaemon({ upstreams: { anthropic: upBase, openai: upBase, google: upBase } });
});

afterAll(async () => {
  await t.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
});

interface Raw {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  firstByteMs: number;
  chunkMs: number[];
  /** [bytes acumulados, performance.now()] por chunk recibido. */
  arrivals: [number, number][];
}

/** Pedido HTTP crudo (sin descompresión) midiendo tiempos de llegada de cada chunk. */
function raw(url: string, body: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      const parts: Buffer[] = [];
      const chunkMs: number[] = [];
      const arrivals: [number, number][] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        const now = performance.now();
        chunkMs.push(now - t0);
        total += c.length;
        arrivals.push([total, now]);
        parts.push(c);
      });
      res.on('end', () =>
        resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts), firstByteMs: chunkMs[0] ?? NaN, chunkMs, arrivals }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

const REQ = JSON.stringify({
  model: 'claude-sonnet-4-5',
  max_tokens: 100,
  stream: true,
  system: 'Sos un asistente de pruebas.',
  messages: [{ role: 'user', content: 'hola ¿qué tal? — prueba con acentos' }],
  tools: [{ name: 'get_weather', description: 'clima', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
});

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;

describe('proxy transparente', () => {
  it('respuesta SSE byte a byte idéntica, headers de upstream preservados, pedido saliente intacto', async () => {
    seen.length = 0;
    const direct = await raw(`${upBase}/v1/messages?beta=true`, REQ, { 'x-api-key': API_KEY });
    const viaProxy = await raw(`${t.base}/proxy/anthropic/v1/messages?beta=true`, REQ, {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'x-cp-session': 'sesion-sdk-1',
    });
    expect(viaProxy.status).toBe(200);
    expect(viaProxy.body.equals(direct.body)).toBe(true);
    expect(viaProxy.body.toString('utf8')).toBe(SSE);
    expect(viaProxy.headers['x-upstream']).toBe('si');
    expect(viaProxy.headers['request-id']).toBe('req_123');
    expect(viaProxy.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(viaProxy.headers['content-type']).toBe('text/event-stream');

    const up = seen[1]!;
    expect(up.url).toBe('/v1/messages?beta=true');
    expect(up.method).toBe('POST');
    expect(up.body.equals(Buffer.from(REQ))).toBe(true);
    expect(up.headers['x-api-key']).toBe(API_KEY);
    expect(up.headers['anthropic-version']).toBe('2023-06-01');
    expect(up.headers['x-cp-session']).toBeUndefined();

    // CP-036: uso extraído de la copia → TurnEvent source 'proxy' con X-CP-Session como sessionId
    const s = await waitFor(() => t.d.pipeline.getSession('sesion-sdk-1'));
    expect(s.source).toBe('proxy');
    expect(s.totals).toMatchObject({ input: 12, cacheRead: 30500, cacheWrite: 2048, output: 57 });
    expect(s.toolsAvailable.map((x) => x.name)).toEqual(['get_weather']);
  });

  it('overhead: primer byte y cada chunk con p95 < 5 ms (50 chunks × 20 ms)', async () => {
    // Todo corre en este proceso (upstream, daemon y cliente): mismo reloj. El retraso de cada
    // chunk se mide contra el instante en que el upstream lo escribió, en la misma corrida.
    const sizes = chunksOf(Buffer.from(SSE), CHUNKS).map((c) => c.length);
    const cum = sizes.map((_, i) => sizes.slice(0, i + 1).reduce((a, b) => a + b, 0));
    const delays = async (url: string, run: string) => {
      const r = await raw(url, REQ, { 'x-run-id': run });
      const sent = sentAt.get(run)!;
      return cum.map((bytes, i) => r.arrivals.find(([n]) => n >= bytes)![1] - sent[i]!);
    };
    const proc = await spawnDaemon({ CONTEXTPILOT_UPSTREAM_ANTHROPIC: upBase });
    for (let i = 0; i < 2; i++) await raw(`${proc.base}/proxy/anthropic/v1/messages-fast`, REQ); // calentamiento
    const ttfb: number[] = [];
    for (let i = 0; i < 20; i++) {
      const d = await raw(`${upBase}/v1/messages-fast`, REQ);
      const p = await raw(`${proc.base}/proxy/anthropic/v1/messages-fast`, REQ);
      ttfb.push(p.firstByteMs - d.firstByteMs);
    }
    const direct: number[] = [];
    const proxied: number[] = [];
    for (let i = 0; i < 3; i++) {
      direct.push(...(await delays(`${upBase}/v1/messages`, `d${i}`)));
      proxied.push(...(await delays(`${proc.base}/proxy/anthropic/v1/messages`, `p${i}`)));
    }
    await proc.stop();
    const added = p95(proxied) - p95(direct);
    console.log(
      `proxy overhead p95: primer byte ${p95(ttfb).toFixed(2)} ms; retraso por chunk p95 directo ${p95(direct).toFixed(2)} ms, vía proxy ${p95(proxied).toFixed(2)} ms (agregado ${added.toFixed(2)} ms)`,
    );
    expect(p95(ttfb)).toBeLessThan(5);
    expect(added).toBeLessThan(5);
  }, 30_000);

  it('JSON gzip: bytes comprimidos idénticos y uso extraído (sesión derivada por hash)', async () => {
    const body = JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'otra conversación única xyz' }] });
    const d = await raw(`${upBase}/v1/json-gzip`, body);
    const p = await raw(`${t.base}/proxy/anthropic/v1/json-gzip`, body, { 'accept-encoding': 'gzip' });
    expect(p.headers['content-encoding']).toBe('gzip');
    expect(p.body.equals(d.body)).toBe(true);
    const s = await waitFor(() => t.d.pipeline.allViews().find((v) => v.source === 'proxy' && v.model === 'claude-haiku-4-5'));
    expect(s.sessionId).toMatch(/^proxy:anthropic:/);
    expect(s.contextSize).toBe(21 + 400 + 9);
  });

  it('errores del upstream pasan tal cual y no generan eventos; upstream caído → 502', async () => {
    const before = t.d.pipeline.allViews().length;
    const r = await raw(`${t.base}/proxy/openai/v1/limit`, '{}');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('3');
    expect(r.body.toString()).toContain('rate_limit_error');
    await new Promise((res) => setTimeout(res, 50));
    expect(t.d.pipeline.allViews().length).toBe(before);

    const dead = await startTestDaemon({ upstreams: { anthropic: 'http://127.0.0.1:1', openai: upBase, google: upBase } });
    const r2 = await raw(`${dead.base}/proxy/anthropic/v1/messages`, REQ);
    expect(r2.status).toBe(502);
    await dead.close();
  });

  it('sin token OK; Origin ajeno → 403; proveedor desconocido → 404', async () => {
    const evil = await fetch(`${t.base}/proxy/anthropic/v1/messages`, { method: 'POST', body: REQ, headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect((await fetch(`${t.base}/proxy/mistral/v1/x`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('RNF-04: la API key no aparece en cp.db ni en ningún archivo del home', async () => {
    t.d.storage.flush();
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const f of walk(t.home)) {
      expect(readFileSync(f).includes(API_KEY), f).toBe(false);
      expect(readFileSync(f).includes('FAKE-KEY'), f).toBe(false);
    }
  });
});
