// Cliente HTTP del daemon (docs/API.md). Token en header X-CP-Token.
import type { AdapterHealth, Config, Feedback, SessionView, Suggestion, TurnEvent } from '@contextpilot/core';
import type { ConnectionTest } from '../messages.js';
import type { SendResult } from './queue.js';

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:47800';

export interface Settings {
  token: string;
  daemonUrl: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export interface SessionDetail {
  view: SessionView;
  timeline: unknown[];
  suggestions: (Suggestion & { feedback?: string })[];
}

export interface Stats {
  byRule: { ruleId: string; savedTokens: number; accepted: number }[];
}

export class DaemonClient {
  constructor(
    private settings: () => Settings,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
    private timeoutMs = 5000,
  ) {}

  private base(): string {
    return (this.settings().daemonUrl || DEFAULT_DAEMON_URL).replace(/\/+$/, '');
  }

  private async req<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) headers['X-CP-Token'] = this.settings().token;
    headers['X-CP-Surface'] = 'extension';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.base() + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) throw new HttpError(res.status, `${method} ${path} → ${res.status}`);
      const ct = res.headers.get('content-type') ?? '';
      return (ct.includes('json') ? await res.json() : await res.text()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  health(): Promise<AdapterHealth[]> {
    return this.req('GET', '/health', undefined, false);
  }

  sessions(): Promise<SessionView[]> {
    return this.req('GET', '/sessions?active=true');
  }

  session(id: string): Promise<SessionDetail> {
    return this.req('GET', `/sessions/${encodeURIComponent(id)}`);
  }

  async ingest(events: TurnEvent[]): Promise<{ accepted: number; suggestions: Suggestion[] }> {
    return this.req('POST', '/ingest/events', events);
  }

  /** Adaptador para EventQueue: 4xx (salvo 401/403/408/429) = descartar; resto = reintentar. */
  async sendBatch(events: TurnEvent[], onSuggestions: (s: Suggestion[]) => void): Promise<SendResult> {
    if (!this.settings().token) return { ok: false, retry: true };
    try {
      const r = await this.ingest(events);
      if (r?.suggestions?.length) onSuggestions(r.suggestions);
      return { ok: true };
    } catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && ![401, 403, 408, 429].includes(e.status))
        return { ok: false, retry: false };
      return { ok: false, retry: true };
    }
  }

  feedback(id: string, feedback: Feedback): Promise<{ ok: boolean }> {
    return this.req('POST', `/suggestions/${encodeURIComponent(id)}/feedback`, { feedback });
  }

  suggestions(sessionId: string): Promise<Suggestion[]> {
    return this.req('GET', `/suggestions?sessionId=${encodeURIComponent(sessionId)}&active=true`);
  }

  handoff(sessionId: string, content: string): Promise<{ summary: string; method: string }> {
    return this.req('POST', '/handoff', { sessionId, content });
  }

  getConfig(): Promise<Config> {
    return this.req('GET', '/config');
  }

  putConfig(patch: Partial<Config>): Promise<Config> {
    return this.req('PUT', '/config', patch);
  }

  stats(): Promise<Stats> {
    return this.req('GET', '/stats');
  }

  /** Opciones: GET /health (sin token) + GET /sessions autenticado. */
  async testConnection(): Promise<ConnectionTest> {
    try {
      await this.health();
    } catch (e) {
      return { health: 'down', auth: 'skipped', detail: e instanceof Error ? e.message : String(e) };
    }
    if (!this.settings().token) return { health: 'ok', auth: 'skipped', detail: 'falta el token' };
    try {
      await this.sessions();
      return { health: 'ok', auth: 'ok' };
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return { health: 'ok', auth: 'unauthorized' };
      return { health: 'ok', auth: 'error', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  streamUrl(): string {
    return `${this.base().replace(/^http/, 'ws')}/stream?token=${encodeURIComponent(this.settings().token)}`;
  }
}
