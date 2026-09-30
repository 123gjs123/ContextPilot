import type { IncomingMessage, ServerResponse } from 'node:http';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Agent, EnvHttpProxyAgent, request, type Dispatcher } from 'undici';
import {
  contextWindowFor,
  createUsageExtractor,
  proxySessionId,
  requestInfo,
  type ExtractResult,
  type Provider,
  type RequestInfo,
  type TurnEvent,
} from '@contextpilot/core';
import type { HealthRegistry } from './health.js';
import type { Logger } from './log.js';
import type { Pipeline } from './pipeline.js';

// CP-035/CP-036: proxy inverso transparente. Reenvía método, path, query, headers (salvo hop-by-hop)
// y body sin tocar; devuelve status, headers y body tal cual, en streaming. El uso se extrae de una
// copia (tee) del stream: si el extractor falla, la respuesta al cliente no se entera.
// RNF-04: nunca se loguean ni persisten headers de autenticación (no se loguean headers en absoluto).

export const DEFAULT_UPSTREAMS: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
};

const ROUTE_PROVIDER: Record<string, Provider> = { anthropic: 'anthropic', openai: 'openai', google: 'google' };

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
/** Headers propios de ContextPilot: no viajan al upstream. */
const OWN = new Set(['x-cp-session', 'x-cp-token']);

export function upstreamsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<Provider, string> {
  return {
    anthropic: env.CONTEXTPILOT_UPSTREAM_ANTHROPIC ?? DEFAULT_UPSTREAMS.anthropic,
    openai: env.CONTEXTPILOT_UPSTREAM_OPENAI ?? DEFAULT_UPSTREAMS.openai,
    google: env.CONTEXTPILOT_UPSTREAM_GOOGLE ?? DEFAULT_UPSTREAMS.google,
  };
}

export interface ProxyOptions {
  upstreams: Record<Provider, string>;
  /** Entorno para HTTP(S)_PROXY / NO_PROXY (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Tests (D-10): reemplaza el extractor de uso del core. */
  extractorFor?: (provider: Provider) => UsageExtractor;
  pipeline: Pipeline;
  health: HealthRegistry;
  log: Logger;
  enabled: () => boolean;
}

export class Proxy {
  private direct: Agent | null = null;
  private viaEnv: Dispatcher | null = null;

  constructor(private o: ProxyOptions) {
    o.health.set('proxy', { status: 'no-data', detail: 'sin tráfico' });
  }

  private dispatcherFor(url: URL): Dispatcher {
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (loopback) return (this.direct ??= new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));
    // D «salida del proxy»: respeta HTTPS_PROXY / HTTP_PROXY / NO_PROXY del entorno del daemon; CAs vía
    // NODE_EXTRA_CA_CERTS.
    const env = this.o.env ?? process.env;
    return (this.viaEnv ??= new EnvHttpProxyAgent({
      headersTimeout: 600_000,
      bodyTimeout: 600_000,
      httpProxy: env.HTTP_PROXY ?? env.http_proxy,
      httpsProxy: env.HTTPS_PROXY ?? env.https_proxy,
      noProxy: env.NO_PROXY ?? env.no_proxy,
    }));
  }

  /** Atiende /proxy/<proveedor><rest> (rest incluye query, tal cual llegó). */
  async handle(req: IncomingMessage, res: ServerResponse, route: string, rest: string): Promise<void> {
    const provider = ROUTE_PROVIDER[route];
    if (!provider) {
      res.writeHead(404).end();
      return;
    }
    if (!this.o.enabled()) {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"proxy deshabilitado"}');
      return;
    }
    const base = this.o.upstreams[provider].replace(/\/+$/, '');
    const url = new URL(base + rest);

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || k === 'host' || OWN.has(k)) continue;
      headers[k] = v;
    }
    const cpSession = firstHeader(req.headers['x-cp-session']);

    // El body del pedido es chico: se lee entero y se reenvía byte a byte idéntico.
    const bodyBuf = await readBody(req);
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    let up: Dispatcher.ResponseData;
    try {
      up = await request(url, {
        method: req.method as Dispatcher.HttpMethod,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf,
        dispatcher: this.dispatcherFor(url),
        signal: ac.signal,
      });
    } catch (e) {
      this.o.log.warn(`proxy ${provider}: upstream inalcanzable (${(e as NodeJS.ErrnoException).code ?? (e as Error).name})`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"upstream inalcanzable"}');
      return;
    }

    const outHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      outHeaders[k] = v as string | string[];
    }
    res.writeHead(up.statusCode, outHeaders);
    res.flushHeaders();

    const ok = up.statusCode >= 200 && up.statusCode < 300;
    const tee = ok
      ? new Tee(
          provider,
          firstHeader(up.headers['content-encoding']) ?? '',
          (m) => this.o.health.set('proxy', { status: 'error', detail: `extractor: ${m}` }),
          this.o.extractorFor,
        )
      : null;
    try {
      for await (const chunk of up.body) {
        if (!res.write(chunk)) await waitDrain(res);
        tee?.push(chunk as Buffer);
      }
      res.end();
    } catch (e) {
      if (!ac.signal.aborted) this.o.log.warn(`proxy ${provider}: stream cortado (${(e as Error).name})`);
      res.destroy();
      return;
    }
    if (!tee) return;
    // El evento se emite después de entregar la respuesta completa: nunca en el camino crítico.
    setImmediate(() => void this.finish(provider, tee, bodyBuf, url.pathname, cpSession));
  }

  private async finish(provider: Provider, tee: Tee, body: Buffer, path: string, cpSession?: string): Promise<void> {
    try {
      const result = await tee.result();
      const usage = result?.usage;
      if (!usage) return;
      let info: RequestInfo | null = null;
      try {
        info = body.length ? requestInfo(provider, JSON.parse(body.toString('utf8')), { url: path }) : null;
      } catch {
        info = null;
      }
      const sessionId = proxySessionId(provider, info ?? {}, cpSession);
      const model = result.model ?? info?.model ?? '';
      const prev = this.o.pipeline.getSession(sessionId);
      const now = Date.now();
      const ev: TurnEvent = {
        id: '',
        source: 'proxy',
        provider,
        client: 'api',
        sessionId,
        turn: (prev?.turns ?? 0) + 1,
        ts: new Date(now).toISOString(),
        model,
        tokens: { ...usage, estimated: false },
        contextSize: usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + usage.output,
        contextWindow: contextWindowFor(model, provider),
        idleSincePrevMs: prev ? Math.max(0, now - Date.parse(prev.lastTurnAt)) : 0,
        promptHash: info?.firstUserHash ?? '',
        promptTokens: info?.promptTokensEstimate,
        toolsAvailable: info?.toolsDeclared.length ? info.toolsDeclared : undefined,
        // D-4: herramientas invocadas en el historial del pedido → uso para R6.
        toolCalls: info?.toolsUsed?.length
          ? info.toolsUsed.map((name) => ({ name, resultTokens: 0, failed: false, argsHash: '' }))
          : undefined,
        // D-14: hash del system prompt para el diff de R3.
        systemHash: info?.systemHash,
        phase: 'response',
      };
      this.o.pipeline.ingest([ev]);
      this.o.health.seen('proxy');
    } catch (e) {
      this.o.health.set('proxy', { status: 'error', detail: `extractor: ${(e as Error).message}` });
    }
  }

  close(): void {
    void this.direct?.close();
    void this.viaEnv?.close();
  }
}

/** Copia del stream hacia el extractor de uso del core; aislada de la respuesta al cliente. */
type UsageExtractor = ReturnType<typeof createUsageExtractor>;

class Tee {
  private decoder = new TextDecoder('utf-8');
  private extractor: UsageExtractor;
  private failed = false;
  private inflater: NodeJS.ReadWriteStream | null = null;
  private inflated: Promise<void> = Promise.resolve();

  constructor(
    provider: Provider,
    encoding: string,
    private onError: (msg: string) => void,
    factory?: (provider: Provider) => UsageExtractor,
  ) {
    this.extractor = (factory ?? createUsageExtractor)(provider);
    const enc = encoding.toLowerCase();
    if (enc === 'gzip' || enc === 'deflate' || enc === 'br') {
      const z = enc === 'gzip' ? createGunzip() : enc === 'br' ? createBrotliDecompress() : createInflate();
      this.inflater = z;
      z.on('data', (d: Buffer) => this.text(d));
      this.inflated = new Promise((resolve) => {
        z.on('end', resolve);
        z.on('error', (e) => {
          this.fail(`descompresión: ${e.message}`);
          resolve();
        });
      });
    }
  }

  private fail(msg: string): void {
    if (this.failed) return;
    this.failed = true;
    this.onError(msg);
  }

  push(chunk: Buffer): void {
    if (this.failed) return;
    try {
      if (this.inflater) this.inflater.write(chunk);
      else this.text(chunk);
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  private text(chunk: Buffer): void {
    if (this.failed) return;
    try {
      this.extractor.push(this.decoder.decode(chunk, { stream: true }));
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  async result(): Promise<ExtractResult | null> {
    if (this.inflater) {
      this.inflater.end();
      await this.inflated;
    }
    if (this.failed) return null;
    try {
      const tail = this.decoder.decode();
      if (tail) this.extractor.push(tail);
      return this.extractor.end();
    } catch (e) {
      this.fail((e as Error).message);
      return null;
    }
  }
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function waitDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}
