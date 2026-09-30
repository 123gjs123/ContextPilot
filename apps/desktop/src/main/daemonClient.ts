import { backoffDelay } from '../shared/backoff.js';
import { parseServerMsg } from '../shared/store.js';
import type { ServerMsg } from '../shared/types.js';
import { readToken } from './settings.js';

// Cliente HTTP + WS del daemon (docs/API.md). Sin Electron: corre en el main de Electron (Node).

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export class DaemonClient {
  private ws?: WebSocket;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly home: string,
    private readonly port: number,
    private readonly handlers: {
      onMessage(m: ServerMsg): void;
      onStatus(s: 'connecting' | 'connected' | 'unavailable', error?: string): void;
      onDown?(attempt: number): void;
    },
  ) {}

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<ApiResult<T>> {
    const token = readToken(this.home);
    try {
      const res = await fetch(this.base + path, {
        method,
        headers: {
          ...(token ? { 'X-CP-Token': token } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        /* texto plano */
      }
      if (!res.ok) {
        const msg = (data as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
        return { ok: false, status: res.status, error: String(msg) };
      }
      return { ok: true, status: res.status, data: data as T };
    } catch (e) {
      return { ok: false, status: 0, error: 'daemon no disponible' + (e instanceof Error ? ` (${e.message})` : '') };
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      this.ws?.close();
    } catch {
      /* ya cerrado */
    }
  }

  private async makeSocket(url: string): Promise<WebSocket> {
    if (typeof globalThis.WebSocket === 'function') return new globalThis.WebSocket(url);
    // Respaldo: paquete `ws` (API compatible con addEventListener).
    const { default: WS } = (await import('ws')) as any;
    return new WS(url) as WebSocket;
  }

  private connect(): void {
    if (this.stopped) return;
    const token = readToken(this.home);
    if (!token) {
      this.handlers.onStatus('unavailable', 'sin token (¿el daemon nunca arrancó?)');
      this.retry();
      return;
    }
    this.handlers.onStatus(this.attempt === 0 ? 'connecting' : 'unavailable');
    const url = `ws://127.0.0.1:${this.port}/stream?token=${encodeURIComponent(token)}`;
    void this.makeSocket(url).then(
      (ws) => {
        this.ws = ws;
        let opened = false;
        ws.addEventListener('open', () => {
          opened = true;
          this.attempt = 0;
          // 'connected' se confirma al recibir 'hello'.
        });
        ws.addEventListener('message', (ev: MessageEvent) => {
          const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8');
          const msg = parseServerMsg(raw);
          if (msg) this.handlers.onMessage(msg);
        });
        ws.addEventListener('close', () => {
          this.handlers.onStatus('unavailable', opened ? 'conexión cerrada' : 'daemon no disponible');
          this.retry();
        });
        ws.addEventListener('error', () => {
          /* 'close' llega después y dispara el reintento */
        });
      },
      (e) => {
        this.handlers.onStatus('unavailable', String(e));
        this.retry();
      },
    );
  }

  private retry(): void {
    if (this.stopped) return;
    this.handlers.onDown?.(this.attempt);
    const delay = backoffDelay(this.attempt++);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  /** Envía feedback por WS si está abierto (equivalente al POST). */
  sendWs(obj: unknown): boolean {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }
}
