// Cola de eventos hacia el daemon (CP-029.3, CP-037.3): máx. 500, FIFO (se descartan los más
// viejos), persistida para sobrevivir al reciclado del service worker, reintento con backoff ≤ 30 s.
import type { TurnEvent } from '@contextpilot/core';

export const QUEUE_MAX = 500;
export const BACKOFF_MAX_MS = 30_000;

export function backoffMs(attempt: number, base = 1000): number {
  return Math.min(BACKOFF_MAX_MS, base * 2 ** Math.max(0, attempt));
}

export interface QueueStore {
  load(): Promise<TurnEvent[]>;
  save(events: TurnEvent[]): Promise<void>;
}

export type SendResult = { ok: true } | { ok: false; retry: boolean };

export class EventQueue {
  private items: TurnEvent[] = [];
  private loaded = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(
    private store: QueueStore,
    private send: (events: TurnEvent[]) => Promise<SendResult>,
    private schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  ) {}

  get size(): number {
    return this.items.length;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.store.load().catch(() => []);
    // Lo encolado en memoria antes de cargar va después de lo persistido.
    this.items = [...stored, ...this.items].slice(-QUEUE_MAX);
    this.loaded = true;
  }

  async push(events: TurnEvent[]): Promise<void> {
    await this.ensureLoaded();
    this.items.push(...events);
    if (this.items.length > QUEUE_MAX) this.items.splice(0, this.items.length - QUEUE_MAX);
    await this.store.save(this.items).catch(() => undefined);
    await this.flush();
  }

  /** Envía todo lo encolado en lotes. Si falla, programa reintento con backoff. */
  async flush(): Promise<void> {
    await this.ensureLoaded();
    if (this.flushing || !this.items.length) return;
    this.flushing = true;
    try {
      while (this.items.length) {
        const batch = this.items.slice(0, 50);
        const r = await this.send(batch).catch((): SendResult => ({ ok: false, retry: true }));
        if (!r.ok) {
          if (!r.retry) {
            // Rechazo definitivo (400: evento inválido): se descarta el lote para no trabar la cola.
            this.items.splice(0, batch.length);
            continue;
          }
          this.retryLater();
          return;
        }
        this.items.splice(0, batch.length);
        this.attempt = 0;
      }
    } finally {
      await this.store.save(this.items).catch(() => undefined);
      this.flushing = false;
    }
  }

  private retryLater(): void {
    if (this.timer) return;
    const ms = backoffMs(this.attempt++);
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  /** Reintento inmediato (p. ej. el WS volvió a conectar). */
  kick(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempt = 0;
    void this.flush();
  }
}
