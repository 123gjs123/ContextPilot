import { existsSync, watch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './log.js';
import type { Storage } from './storage.js';

// CP-031: tailer incremental por offset de bytes sobre un directorio (fs.watch recursivo + rescan
// lento de respaldo). Líneas partidas esperan a su '\n'. Al arrancar:
//  - archivo con offset persistido y modificado hace poco → 'warm' (re-parsea hasta el offset sin
//    emitir, para reconstruir el estado del parser) y sigue desde el offset;
//  - sin offset y modificado hace poco (< recentMs) → 'replay' desde el inicio;
//  - sin offset y viejo → sólo registra el offset al final.

export type TailMode = 'warm' | 'replay' | 'live';

export interface TailConsumer {
  /** Parte el buffer en unidades completas; por defecto líneas terminadas en '\n'. */
  split?(buf: Buffer): { units: string[]; consumed: number };
  onUnits(file: string, units: string[], mode: TailMode): void;
  /** El archivo se truncó o reescribió: descartar estado del parser. */
  onReset?(file: string): void;
}

export interface TailerOptions {
  name: string;
  root: string;
  match(file: string): boolean;
  recentMs: number;
  storage: Storage;
  log: Logger;
  consumer: TailConsumer;
  /** Rescan completo de respaldo (ms). Default 60 s (CP-028: nada de polling < 1 s). */
  rescanMs?: number;
  /** Re-chequeo de existencia del directorio raíz cuando falta (ms). Default 30 s. */
  rootRetryMs?: number;
  /** Debounce de eventos de fs.watch por archivo (ms). */
  debounceMs?: number;
  onRootState?(exists: boolean): void;
  /** Recorre subdirectorios (default true). */
  recursive?: boolean;
}

interface FileState {
  path: string;
  pos: number;
  pending: Buffer;
  reading: boolean;
  again: boolean;
  mode: TailMode;
  timer: NodeJS.Timeout | null;
}

const CHUNK = 1 << 20;

export function splitLines(buf: Buffer): { units: string[]; consumed: number } {
  const last = buf.lastIndexOf(0x0a);
  if (last < 0) return { units: [], consumed: 0 };
  const text = buf.subarray(0, last + 1).toString('utf8');
  const units = text.split('\n');
  units.pop();
  return { units: units.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0), consumed: last + 1 };
}

export class Tailer {
  private files = new Map<string, FileState>();
  private discovering = new Set<string>();
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private rootTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private started = false;
  private initialDone: Promise<void> = Promise.resolve();

  constructor(private o: TailerOptions) {}

  get root(): string {
    return this.o.root;
  }

  trackedFiles(): string[] {
    return [...this.files.keys()];
  }

  /** Arranca; resuelve cuando terminó el escaneo inicial (replay incluido). */
  start(): Promise<void> {
    if (this.started) return this.initialDone;
    this.started = true;
    this.stopped = false;
    this.initialDone = this.attach();
    return this.initialDone;
  }

  private async attach(): Promise<void> {
    if (this.stopped) return;
    if (!existsSync(this.o.root)) {
      this.o.onRootState?.(false);
      this.rootTimer = setTimeout(() => {
        this.rootTimer = null;
        void this.attach();
      }, this.o.rootRetryMs ?? 30_000);
      this.rootTimer.unref();
      return;
    }
    this.o.onRootState?.(true);
    this.watch();
    await this.scan(true);
    this.rescanTimer = setInterval(() => void this.scan(false), this.o.rescanMs ?? 60_000);
    this.rescanTimer.unref();
  }

  private watch(): void {
    try {
      this.watcher = watch(this.o.root, { recursive: this.o.recursive !== false }, (_evt, filename) => {
        if (!filename) return;
        const full = join(this.o.root, filename.toString());
        if (this.o.match(full)) this.poke(full);
      });
      this.watcher.on('error', (err) => {
        this.o.log.warn(`${this.o.name}: watcher error ${(err as Error).message}; queda el rescan`);
        this.watcher?.close();
        this.watcher = null;
        if (!existsSync(this.o.root)) {
          this.detach();
          void this.attach();
        }
      });
    } catch (e) {
      this.o.log.warn(`${this.o.name}: fs.watch no disponible (${(e as Error).message}); sólo rescan`);
    }
  }

  private detach(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
  }

  private async scan(initial: boolean): Promise<void> {
    if (this.stopped) return;
    let entries: string[];
    try {
      entries = (await readdir(this.o.root, { recursive: this.o.recursive !== false })) as string[];
    } catch {
      if (!existsSync(this.o.root)) {
        this.detach();
        this.started = true;
        void this.attach();
      }
      return;
    }
    for (const rel of entries) {
      if (this.stopped) return;
      const full = join(this.o.root, rel);
      if (!this.o.match(full)) continue;
      const known = this.files.has(full);
      if (!known) await this.discover(full, initial);
      else this.poke(full, 0);
    }
  }

  /** Alta de un archivo nuevo para el tailer (también usado por hooks con rutas fuera del root). */
  async discover(path: string, initial: boolean): Promise<void> {
    // Varios eventos de fs.watch pueden llegar antes de que termine el stat: una sola alta.
    if (this.files.has(path) || this.discovering.has(path) || this.stopped) return;
    this.discovering.add(path);
    let st;
    try {
      st = await stat(path);
    } catch {
      return;
    } finally {
      this.discovering.delete(path);
    }
    if (!st.isFile() || this.files.has(path) || this.stopped) return;
    const fs: FileState = { path, pos: 0, pending: Buffer.alloc(0), reading: false, again: false, mode: 'live', timer: null };
    this.files.set(path, fs);
    const persisted = this.o.storage.getOffset(path);
    const recent = Date.now() - st.mtimeMs < this.o.recentMs;
    if (persisted !== undefined && persisted <= st.size) {
      if (recent && persisted > 0) {
        fs.mode = 'warm';
        await this.read(fs, persisted);
      }
      fs.pos = persisted;
      fs.pending = Buffer.alloc(0);
      fs.mode = 'replay';
    } else if (initial && !recent) {
      fs.pos = st.size;
      this.o.storage.setOffset(path, st.size);
      fs.mode = 'live';
      return;
    } else {
      fs.mode = initial ? 'replay' : 'live';
    }
    await this.read(fs);
    fs.mode = 'live';
  }

  /** Marca un archivo para leer lo nuevo (debounce). */
  poke(path: string, debounce = this.o.debounceMs ?? 20): void {
    const fs = this.files.get(path);
    if (!fs) {
      void this.discover(path, false);
      return;
    }
    if (fs.timer) return;
    fs.timer = setTimeout(() => {
      fs.timer = null;
      void this.read(fs);
    }, debounce);
    fs.timer.unref();
  }

  /** Lee desde fs.pos hasta el final (o hasta `limit` bytes en modo warm). */
  private async read(fs: FileState, limit?: number): Promise<void> {
    if (fs.reading) {
      fs.again = true;
      return;
    }
    fs.reading = true;
    try {
      do {
        fs.again = false;
        await this.readOnce(fs, limit);
      } while (fs.again && !this.stopped);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') this.files.delete(fs.path);
      else this.o.log.warn(`${this.o.name}: error leyendo archivo (${code ?? (e as Error).message})`);
    } finally {
      fs.reading = false;
    }
  }

  private async readOnce(fs: FileState, limit?: number): Promise<void> {
    const fh = await open(fs.path, 'r');
    try {
      const { size } = await fh.stat();
      if (size < fs.pos) {
        // Truncado o reescrito: empezar de nuevo.
        fs.pos = 0;
        fs.pending = Buffer.alloc(0);
        this.o.consumer.onReset?.(fs.path);
      }
      const end = limit !== undefined ? Math.min(limit, size) : size;
      const split = this.o.consumer.split ?? splitLines;
      while (fs.pos < end && !this.stopped) {
        const len = Math.min(CHUNK, end - fs.pos);
        const chunk = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(chunk, 0, len, fs.pos);
        if (!bytesRead) break;
        fs.pos += bytesRead;
        const buf = fs.pending.length ? Buffer.concat([fs.pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const { units, consumed } = split(buf);
        fs.pending = Buffer.from(buf.subarray(consumed));
        if (units.length) this.o.consumer.onUnits(fs.path, units, fs.mode);
      }
      if (fs.mode !== 'warm') this.o.storage.setOffset(fs.path, fs.pos - fs.pending.length);
    } finally {
      await fh.close();
    }
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.detach();
    if (this.rootTimer) clearTimeout(this.rootTimer);
    this.rootTimer = null;
    for (const f of this.files.values()) if (f.timer) clearTimeout(f.timer);
    this.files.clear();
  }
}
