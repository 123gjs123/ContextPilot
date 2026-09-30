import { dirname, resolve } from 'node:path';
import { GeminiTelemetryParser, parseGeminiOutfile, type TurnEvent } from '@contextpilot/core';
import type { HealthRegistry } from '../health.js';
import type { Logger } from '../log.js';
import type { Pipeline } from '../pipeline.js';
import type { Storage } from '../storage.js';
import { Tailer, type TailMode } from '../tailer.js';

// RF-CAP-04 / CP-034: telemetría de Gemini CLI. Fuente primaria: telemetry.outfile (objetos JSON
// concatenados, posiblemente multilínea); secundaria: OTLP/HTTP JSON en POST /otlp/v1/logs.

const NAME = 'gemini-cli';

/**
 * Corta un buffer en objetos JSON de nivel superior completos (respetando strings y escapes) y
 * devuelve cuántos bytes se consumieron: el tailer necesita el offset en bytes para reanudar.
 */
export function splitJsonObjects(buf: Buffer): { units: string[]; consumed: number } {
  const units: string[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  let consumed = 0;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === 0x5c) esc = true;
      else if (ch === 0x22) inStr = false;
      continue;
    }
    if (ch === 0x22) inStr = depth > 0;
    else if (ch === 0x7b || ch === 0x5b) {
      if (depth === 0) start = i;
      depth++;
    } else if ((ch === 0x7d || ch === 0x5d) && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        units.push(buf.subarray(start, i + 1).toString('utf8'));
        consumed = i + 1;
        start = -1;
      }
    } else if (depth === 0) {
      // espacios o basura entre objetos: se consumen
      consumed = i + 1;
    }
  }
  return { units, consumed };
}

export interface GeminiAdapterOptions {
  outfile: string;
  recentMs: number;
  pipeline: Pipeline;
  storage: Storage;
  health: HealthRegistry;
  log: Logger;
  rescanMs?: number;
  rootRetryMs?: number;
}

export class GeminiAdapter {
  private fileParser = new GeminiTelemetryParser();
  private otlpParser = new GeminiTelemetryParser();
  private tailer: Tailer;
  private ready: Promise<void> = Promise.resolve();

  constructor(private o: GeminiAdapterOptions) {
    const target = resolve(o.outfile);
    this.tailer = new Tailer({
      name: NAME,
      root: dirname(target),
      match: (f) => resolve(f).toLowerCase() === target.toLowerCase(),
      recursive: false,
      recentMs: o.recentMs,
      storage: o.storage,
      log: o.log,
      rescanMs: o.rescanMs,
      rootRetryMs: o.rootRetryMs,
      consumer: {
        split: splitJsonObjects,
        onUnits: (_f, units, mode) => this.onUnits(units, mode),
        onReset: () => (this.fileParser = new GeminiTelemetryParser()),
      },
      onRootState: (exists) => {
        if (!exists) o.health.set(NAME, { status: 'no-data', detail: `sin ${o.outfile}` });
      },
    });
  }

  start(): Promise<void> {
    this.o.health.set(NAME, { status: 'no-data', detail: `esperando ${this.o.outfile}` });
    this.ready = this.tailer.start();
    return this.ready;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  stop(): void {
    this.tailer.stop();
  }

  private onUnits(units: string[], mode: TailMode): void {
    const records: unknown[] = [];
    for (const u of units) {
      const parsed = parseGeminiOutfile(u);
      if (parsed.length) {
        records.push(...parsed);
        this.o.health.lineOk(NAME);
      } else this.o.health.lineError(NAME, 'registros de telemetría inválidos');
    }
    const events = this.feed(this.fileParser, records);
    if (mode !== 'warm') this.emit(events, this.fileParser, mode === 'replay');
  }

  /** POST /otlp/v1/logs (CP-034.2): el parser del core acepta el payload OTLP completo. */
  ingestOtlp(body: unknown): TurnEvent[] {
    const events = this.feed(this.otlpParser, [body]);
    this.emit(events, this.otlpParser, false);
    return events;
  }

  private feed(p: GeminiTelemetryParser, records: unknown[]): TurnEvent[] {
    const out: TurnEvent[] = [];
    for (const r of records) {
      const before = p.errors;
      out.push(...p.feed(r));
      if (p.errors > before) this.o.health.lineError(NAME, 'el parser rechazó registros');
    }
    return out;
  }

  private emit(events: TurnEvent[], p: GeminiTelemetryParser, replay: boolean): void {
    if (!events.length) return;
    this.o.pipeline.ingest(events, { replay });
    this.o.health.seen(NAME, [...p.formatVersions].at(-1), events.at(-1)!.ts);
  }
}
