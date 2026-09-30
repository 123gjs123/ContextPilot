import type { TurnEvent } from '@contextpilot/core';
import type { HealthRegistry } from '../health.js';
import type { Logger } from '../log.js';
import type { Pipeline } from '../pipeline.js';
import type { Storage } from '../storage.js';
import { Tailer, type TailMode } from '../tailer.js';

// Adaptador genérico «directorio de JSONL + parser por archivo» (Claude Code, Codex).

export interface LineParser {
  feed(line: string): TurnEvent[];
  formatVersions?: Set<string>;
  errors?: number;
  sessionId?: string;
  /** D-2: foco en memoria para `/compact <foco>` (sólo Claude Code). */
  focus?(): string | undefined;
}

export interface JsonlAdapterOptions {
  name: string;
  root: string;
  match(file: string): boolean;
  /** Crea el parser para un archivo; null si el core no lo exporta aún (health error). */
  parserFor(file: string): LineParser | null;
  /** Sesión conocida por la ruta (para registrar el transcript antes del primer evento). */
  sessionIdFor?(file: string): string | null | undefined;
  /* null = no registrar este archivo como transcript (p. ej. subagentes). */
  missingDetail?: string;
  recentMs: number;
  pipeline: Pipeline;
  storage: Storage;
  health: HealthRegistry;
  log: Logger;
  rescanMs?: number;
  rootRetryMs?: number;
}

export class JsonlAdapter {
  private parsers = new Map<string, LineParser | null>();
  private registered = new Set<string>();
  readonly tailer: Tailer;
  private ready: Promise<void> = Promise.resolve();

  constructor(private o: JsonlAdapterOptions) {
    this.tailer = new Tailer({
      name: o.name,
      root: o.root,
      match: o.match,
      recentMs: o.recentMs,
      storage: o.storage,
      log: o.log,
      rescanMs: o.rescanMs,
      rootRetryMs: o.rootRetryMs,
      consumer: {
        onUnits: (file, lines, mode) => this.onLines(file, lines, mode),
        onReset: (file) => this.parsers.delete(file),
      },
      onRootState: (exists) => {
        const cur = o.health.get(o.name);
        if (!exists) o.health.set(o.name, { status: 'no-data', detail: `sin directorio ${o.root}` });
        else if (!cur || cur.status === 'no-data') o.health.set(o.name, { status: 'no-data', detail: 'esperando eventos' });
      },
    });
  }

  start(): Promise<void> {
    this.o.health.set(this.o.name, { status: 'no-data', detail: 'iniciando' });
    this.ready = this.tailer.start();
    return this.ready;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  stop(): void {
    this.tailer.stop();
    this.parsers.clear();
    this.registered.clear();
  }

  /** D-2: foco del parser en memoria del transcript principal de la sesión (sin leer disco). */
  focusFor(sessionId: string): string | undefined {
    for (const [file, p] of this.parsers) {
      if (p && this.o.sessionIdFor?.(file) === sessionId) return p.focus?.();
    }
    return undefined;
  }

  /** Lee ya lo nuevo de un archivo (hooks Stop/UserPromptSubmit aceleran la latencia). */
  poke(file: string): void {
    this.tailer.poke(file, 0);
  }

  private parser(file: string): LineParser | null {
    if (!this.parsers.has(file)) this.parsers.set(file, this.o.parserFor(file));
    return this.parsers.get(file)!;
  }

  private onLines(file: string, lines: string[], mode: TailMode): void {
    const p = this.parser(file);
    if (!p) {
      this.o.health.set(this.o.name, { status: 'error', detail: this.o.missingDetail ?? 'parser no disponible' });
      return;
    }
    const events: TurnEvent[] = [];
    let batchErrors = 0;
    for (const line of lines) {
      const before = p.errors ?? 0;
      let evs: TurnEvent[] = [];
      try {
        evs = p.feed(line);
      } catch (e) {
        batchErrors++;
        this.o.health.lineError(this.o.name, `el parser lanzó: ${(e as Error).message}`);
        continue;
      }
      if ((p.errors ?? 0) > before) {
        batchErrors++;
        this.o.health.lineError(this.o.name, 'líneas JSONL inválidas');
      }
      else this.o.health.lineOk(this.o.name);
      for (const ev of evs) events.push(ev);
    }
    if (!this.registered.has(file)) {
      const known = this.o.sessionIdFor?.(file);
      const sid = known === null ? null : (known ?? events[0]?.sessionId ?? p.sessionId);
      if (known === null) this.registered.add(file);
      else if (sid) {
        this.o.storage.setTranscript(sid, file, this.o.name);
        this.registered.add(file);
      }
    }
    if (mode === 'warm' || !events.length) return;
    this.o.pipeline.ingest(events, { replay: mode === 'replay' });
    const versions = p.formatVersions ? [...p.formatVersions] : [];
    const last = events.at(-1)!;
    // Se recupera de 'error' sólo con un lote limpio (CP-027.3: nunca cifras parciales).
    if (!batchErrors || this.o.health.get(this.o.name)?.status !== 'error') this.o.health.seen(this.o.name, versions.at(-1), last.ts);
    else this.o.health.set(this.o.name, { lastEventAt: last.ts, formatVersion: versions.at(-1) });
  }
}
