// Cliente WS de /stream con reconexión por backoff (1 s → 30 s).
// MV3: el service worker se recicla tras ~30 s sin actividad. Desde Chrome 116 los mensajes WS
// extienden su vida, así que mandamos un keepalive cada 20 s mientras hay conexión; si igual se
// recicla, se reconecta al próximo evento (mensaje de pestaña, side panel, cambio de pestaña).
import type { AdapterHealth, SessionView, Suggestion } from '@contextpilot/core';
import { backoffMs } from './queue.js';

export type ServerMsg =
  | { type: 'hello'; data: { version: string; sessions: SessionView[]; suggestions: Suggestion[]; health: AdapterHealth[] } }
  | { type: 'session'; data: SessionView }
  | { type: 'suggestion'; data: Suggestion }
  | { type: 'suggestion-cleared'; data: { id: string; sessionId: string; feedback?: string } }
  | { type: 'health'; data: AdapterHealth[] };

export interface StreamHandlers {
  onMessage(m: ServerMsg): void;
  onOpen(): void;
  /** code 4401 = token inválido (el daemon cierra así el WS). */
  onClose(code: number): void;
}

const KEEPALIVE_MS = 20_000;

export class StreamClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private keepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private url: () => string | null,
    private h: StreamHandlers,
    private WS: typeof WebSocket = WebSocket,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === 1;
  }

  /** Idempotente: si ya hay conexión (o intento en curso) no hace nada. */
  ensure(): void {
    this.stopped = false;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    if (this.retryTimer) return;
    this.connect();
  }

  restart(): void {
    this.close();
    this.attempt = 0;
    this.ensure();
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearKeepalive();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignorar */
    }
  }

  send(obj: unknown): boolean {
    if (!this.connected) return false;
    this.ws!.send(JSON.stringify(obj));
    return true;
  }

  private connect(): void {
    const url = this.url();
    if (!url) return; // sin token: no se intenta
    let ws: WebSocket;
    try {
      ws = new this.WS(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.startKeepalive();
      this.h.onOpen();
    };
    ws.onmessage = (ev) => {
      try {
        this.h.onMessage(JSON.parse(String(ev.data)) as ServerMsg);
      } catch {
        /* mensaje no JSON */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearKeepalive();
      this.h.onClose(ev.code);
      // Token rechazado: no insistir hasta que cambie la configuración (restart()).
      if (ev.code === 4401) this.stopped = true;
      if (!this.stopped) this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose se encarga */
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, backoffMs(this.attempt++));
  }

  private startKeepalive(): void {
    this.clearKeepalive();
    // El daemon ignora tipos desconocidos; el tráfico mantiene vivo el service worker.
    this.keepTimer = setInterval(() => this.send({ type: 'ping' }), KEEPALIVE_MS);
  }

  private clearKeepalive(): void {
    if (this.keepTimer) clearInterval(this.keepTimer);
    this.keepTimer = null;
  }
}
