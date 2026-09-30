import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { redact, shortAction, toView, validateTurnEvent, type Feedback, type SessionView, type Suggestion } from '@contextpilot/core';
import type { Daemon } from './daemon.js';
import { HandoffError } from './handoff.js';
import type { IncomingEvent } from './pipeline.js';
import { computeStats, parseRange } from './stats.js';

// API local (docs/API.md): node:http + ws, sin framework. Sólo 127.0.0.1.
// Auth: X-CP-Token salvo GET /health, /proxy/*, POST /otlp/v1/logs. Origin: chrome-extension://<id>
// (con `daemon.allowedExtensionIds` configurado sólo esos ids; vacío = cualquiera, D-9), file://
// (Origin «null») o ausente; cualquier otro → 403.

const MAX_BODY = 10 * 1024 * 1024;
const FEEDBACKS: Feedback[] = ['accepted', 'dismissed', 'snoozed'];
const KNOWN_HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop', 'SessionEnd', 'SubagentStop', 'Notification']);

export type ServerMsg =
  | { type: 'hello'; data: { version: string; sessions: SessionView[]; suggestions: Suggestion[]; health: unknown[] } }
  | { type: 'session'; data: SessionView }
  | { type: 'suggestion'; data: Suggestion }
  | { type: 'suggestion-cleared'; data: { id: string; sessionId: string; feedback?: string } }
  | { type: 'health'; data: unknown[] };

export function originAllowed(origin: string | undefined, allowedExtensionIds: readonly string[] = []): boolean {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null' || origin.startsWith('file://')) return true;
  if (!origin.startsWith('chrome-extension://')) return false;
  // D-9 / CP-022.4: con ids configurados, sólo esas extensiones.
  if (!allowedExtensionIds.length) return true;
  const id = origin.slice('chrome-extension://'.length).replace(/\/.*$/, '');
  return allowedExtensionIds.includes(id);
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function tokenOk(given: string | undefined | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(String(status));
  }
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    req.on('data', (c: Buffer) => {
      len += c.length;
      if (len > MAX_BODY) {
        reject(new HttpError(413, { error: 'body demasiado grande' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, { error: 'JSON inválido' }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Línea de statusline (CP-025.3): `ctx 68% · cache 91% · ⚠ /compact`, ≤ 80 columnas.
 * D-3: la acción corta sale de la regla (`shortAction` del core), nunca del texto a copiar.
 * D-1: la sugerencia de cuenta del proveedor (R10) se agrega al final como aviso de cuenta.
 */
export function statuslineText(
  view: SessionView | undefined,
  visible: Suggestion | undefined,
  broken: boolean,
  account?: Suggestion,
): string {
  if (!view || broken) return 'ContextPilot: sin datos';
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  const est = view.estimated ? '≈' : '';
  const parts = [`ctx ${est}${pct(view.contextPct)}`];
  if (view.cachePct !== null && view.cachePct !== undefined) parts.push(`cache ${est}${pct(view.cachePct)}`);
  if (visible && !visible.quiet) parts.push(`⚠ ${shortAction(visible)}`);
  if (account && !account.quiet) parts.push(`⏳ ${shortAction(account)}`);
  const line = parts.join(' · ');
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function createApp(d: Daemon): { server: Server; wss: WebSocketServer; broadcast(msg: ServerMsg): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set<WebSocket>();

  const broadcast = (msg: ServerMsg) => {
    const text = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(text);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) send(res, e.status, e.body);
      else {
        d.log.error(`HTTP ${req.method} ${(req.url ?? '').split('?')[0]}: ${(e as Error).message}`);
        send(res, 500, { error: 'error interno' });
      }
    });
  });
  // Streams largos del proxy: sin timeout de request.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const origin = req.headers.origin;

    if (!originAllowed(origin, d.config.daemon.allowedExtensionIds)) return send(res, 403);
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }
    if (method === 'OPTIONS') {
      return send(res, 204, undefined, {
        'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
        'access-control-allow-headers': 'content-type, x-cp-token, x-cp-surface',
        'access-control-max-age': '600',
      });
    }

    // ---- sin token ----
    const pm = /^\/proxy\/([a-z]+)(?=\/|$)/.exec(path);
    if (pm) {
      const rest = rawUrl.slice(`/proxy/${pm[1]}`.length) || '/';
      return d.proxy.handle(req, res, pm[1]!, rest.startsWith('/') ? rest : `/${rest}`);
    }
    if (method === 'GET' && path === '/health') return send(res, 200, d.healthList());
    if (method === 'POST' && path === '/otlp/v1/logs') {
      if (!isLoopback(req)) return send(res, 403);
      const body = await readJson(req);
      d.ingestOtlp(body);
      return send(res, 200, {});
    }

    // ---- con token ----
    if (!tokenOk(firstHeader(req.headers['x-cp-token']), d.token)) return send(res, 401);

    if (method === 'POST' && path === '/ingest/events') {
      const body = await readJson(req);
      const list: IncomingEvent[] = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
      if (!Array.isArray(body) && !(body && typeof body === 'object')) return send(res, 400, { error: 'se esperaba TurnEvent[]' });
      const valid: IncomingEvent[] = [];
      for (const [i, ev] of list.entries()) {
        // El validador del core completa id/ts y descarta campos desconocidos.
        const r = validateTurnEvent(ev);
        if (!r.ok) return send(res, 400, { error: 'evento inválido', index: i, field: r.errors[0]!.split(':')[0], errors: r.errors });
        // `content` (opt-in por fuente, RNF-01) viaja aparte: el pipeline decide si se persiste.
        valid.push(typeof ev?.content === 'string' ? { ...r.event, content: ev.content } : r.event);
      }
      const out = d.pipeline.ingest(valid);
      return send(res, 202, out);
    }

    let m = /^\/ingest\/hooks\/([A-Za-z]+)$/.exec(path);
    if (method === 'POST' && m) {
      const body = (await readJson(req)) ?? {};
      const known = KNOWN_HOOKS.has(m[1]!);
      d.onHook(m[1]!, body, known);
      return send(res, known ? 200 : 202, { ok: true });
    }

    if (method === 'GET' && path === '/sessions') {
      const active = url.searchParams.get('active') === 'true';
      const views = active ? d.pipeline.activeViews() : d.pipeline.allViews();
      return send(
        res,
        200,
        views.map((v) => ({ ...v, suggestion: d.pipeline.visibleFor(v.sessionId) })),
      );
    }

    // D-1: sugerencias de cuenta vigentes (una por proveedor) para el banner de cuenta de las UIs.
    if (method === 'GET' && path === '/account') {
      return send(res, 200, { suggestions: d.pipeline.accountSuggestions(), burn: d.burnByProvider() });
    }

    m = /^\/sessions\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const id = decodeURIComponent(m[1]!);
      const s = d.pipeline.getSession(id);
      if (!s) return send(res, 404, { error: 'sesión desconocida' });
      return send(res, 200, {
        view: toView(s),
        timeline: d.storage.timeline(id),
        suggestions: d.storage.listSuggestions({ sessionId: id }).map((s) => d.pipeline.decorate(s)),
      });
    }

    m = /^\/statusline\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const id = decodeURIComponent(m[1]!);
      const s = d.pipeline.getSession(id);
      const account = s ? d.pipeline.visibleFor(`account:${s.provider}`) : undefined;
      const text = statuslineText(s ? toView(s) : undefined, s ? d.pipeline.visibleFor(id) : undefined, s ? d.health.isBroken(s.source) : false, account);
      return send(res, 200, text);
    }

    if (method === 'GET' && path === '/suggestions') {
      return send(
        res,
        200,
        d.storage
          .listSuggestions({
            sessionId: url.searchParams.get('sessionId') || undefined,
            active: url.searchParams.get('active') === 'true',
          })
          .map((s) => d.pipeline.decorate(s)),
      );
    }

    m = /^\/suggestions\/([^/]+)\/feedback$/.exec(path);
    if (method === 'POST' && m) {
      const body = (await readJson(req)) ?? {};
      if (!FEEDBACKS.includes(body.feedback)) return send(res, 400, { error: 'feedback inválido' });
      const surface = typeof body.surface === 'string' ? body.surface : firstHeader(req.headers['x-cp-surface']);
      if (!d.pipeline.feedback(decodeURIComponent(m[1]!), body.feedback, surface)) return send(res, 404, { error: 'sugerencia desconocida' });
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/handoff') {
      const body = (await readJson(req)) ?? {};
      if (typeof body.sessionId !== 'string' || !body.sessionId) return send(res, 400, { error: 'sessionId requerido' });
      if (body.content !== undefined && typeof body.content !== 'string') return send(res, 400, { error: 'content debe ser texto' });
      try {
        return send(res, 200, await d.handoff(body.sessionId, body.content));
      } catch (e) {
        if (e instanceof HandoffError) return send(res, e.status, { error: e.message });
        throw e;
      }
    }

    if (path === '/config' && method === 'GET') return send(res, 200, d.config);
    if (path === '/config' && method === 'PUT') {
      const body = await readJson(req);
      const r = d.updateConfig(body, 'merge');
      return 'error' in r ? send(res, 400, { error: r.error }) : send(res, 200, r.config);
    }
    if (path === '/config/export' && method === 'GET') {
      return send(res, 200, d.config, { 'content-disposition': 'attachment; filename="contextpilot-config.json"' });
    }
    if (path === '/config/import' && method === 'POST') {
      const body = await readJson(req);
      const dryRun = url.searchParams.get('dryRun') === 'true';
      const r = d.updateConfig(body, dryRun ? 'dry-run' : 'replace');
      return 'error' in r ? send(res, 400, { error: r.error }) : send(res, 200, r.config);
    }

    if (method === 'GET' && path === '/stats') {
      const r = parseRange(url.searchParams.get('from'), url.searchParams.get('to'));
      // D-5: ritmo y proyección por proveedor (`burn`).
      return send(res, 200, { ...computeStats(d.storage, r.from, r.to), planUsage: d.planUsage?.latest(), burn: d.burnByProvider() });
    }

    if (method === 'GET' && path === '/team/export') {
      const r = parseRange(url.searchParams.get('from'), url.searchParams.get('to'));
      return send(res, 200, d.teamExport(r.from, r.to), { 'content-disposition': 'attachment; filename="contextpilot-team.json"' });
    }

    return send(res, 404);
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/stream') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if (!originAllowed(req.headers.origin, d.config.daemon.allowedExtensionIds)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const ok = tokenOk(url.searchParams.get('token'), d.token);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!ok) {
        ws.close(4401, 'token inválido');
        return;
      }
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg?.type === 'feedback' && typeof msg.data?.id === 'string' && FEEDBACKS.includes(msg.data.feedback)) {
            d.pipeline.feedback(msg.data.id, msg.data.feedback, typeof msg.data.surface === 'string' ? msg.data.surface : 'ws');
          }
        } catch {
          // mensajes inválidos se ignoran
        }
      });
      const hello: ServerMsg = {
        type: 'hello',
        data: {
          version: d.version,
          sessions: d.pipeline.activeViews(),
          suggestions: d.pipeline.activeSuggestions(),
          health: d.healthList(),
        },
      };
      ws.send(JSON.stringify(hello));
    });
  });

  return { server, wss, broadcast };
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Sólo para el contenido opt-in de hooks: redacta antes de persistir. */
export function redactPrompt(p: unknown): string | null {
  return typeof p === 'string' && p.trim() ? redact(p) : null;
}
