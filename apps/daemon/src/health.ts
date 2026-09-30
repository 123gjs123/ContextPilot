import { EventEmitter } from 'node:events';
import type { AdapterHealth } from '@contextpilot/core';

// CP-027 / RNF-09: estado por adaptador. Cambios de status se emiten (debounce) para el WS.

const CONSECUTIVE_ERRORS_FOR_ERROR = 3;

export class HealthRegistry extends EventEmitter {
  private items = new Map<string, AdapterHealth>();
  private consecutiveErrors = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  /** Contadores auxiliares (hooks desconocidos, errores del extractor, etc.). */
  readonly counters = new Map<string, number>();

  set(name: string, patch: Partial<AdapterHealth>): void {
    const isNew = !this.items.has(name);
    const cur = this.items.get(name) ?? { name, status: 'no-data' as const };
    const next: AdapterHealth = { ...cur, ...patch, name };
    const changed = cur.status !== next.status || cur.detail !== next.detail || cur.formatVersion !== next.formatVersion;
    this.items.set(name, next);
    if (changed || isNew) this.schedule();
  }

  get(name: string): AdapterHealth | undefined {
    return this.items.get(name);
  }

  /** Registra un evento válido: status ok salvo que esté deshabilitado. */
  seen(name: string, formatVersion?: string, ts = new Date().toISOString()): void {
    const cur = this.items.get(name);
    if (cur?.status === 'disabled') return;
    this.consecutiveErrors.set(name, 0);
    const patch: Partial<AdapterHealth> = { lastEventAt: ts };
    if (formatVersion) patch.formatVersion = formatVersion;
    if (cur?.status !== 'ok') {
      patch.status = 'ok';
      patch.detail = undefined;
    }
    this.set(name, patch);
  }

  /** Línea procesada sin error (resetea la racha). */
  lineOk(name: string): void {
    if (this.consecutiveErrors.get(name)) this.consecutiveErrors.set(name, 0);
  }

  /** CP-027.3: ≥ 3 fallos seguidos → error. */
  lineError(name: string, detail: string): void {
    const n = (this.consecutiveErrors.get(name) ?? 0) + 1;
    this.consecutiveErrors.set(name, n);
    if (n >= CONSECUTIVE_ERRORS_FOR_ERROR) this.set(name, { status: 'error', detail });
  }

  count(key: string): number {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }

  isBroken(name: string): boolean {
    const s = this.items.get(name)?.status;
    return s === 'error' || s === 'disabled';
  }

  list(): AdapterHealth[] {
    return [...this.items.values()].map((h) => structuredClone(h));
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit('change', this.list());
    }, 100);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
