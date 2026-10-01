import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnEvent } from '@contextpilot/core';
import type { HealthRegistry } from '../../health.js';
import type { Logger } from '../../log.js';
import type { Pipeline } from '../../pipeline.js';
import type { Storage } from '../../storage.js';
import { decodeIdbValue } from './idbValue.js';
import { readLog } from './ldbLog.js';
import { desktopSessionId, isStoreRecord, STORE_FORMAT, turnsFromRecord, type StoreRecord } from './mapTurns.js';

// Adaptador Claude Desktop (CP-043, H-1): lee EN MODO SÓLO LECTURA la IndexedDB
// `claude-conversation-store` del perfil de la app (docs/SPIKE-desktop-traffic.md).
// Lista blanca estricta: sólo abre `*.log` de la carpeta .leveldb y los archivos de la carpeta .blob.
// Nunca toca Cookies, config.json, Local State ni nada fuera de esas dos carpetas. El texto de las
// conversaciones se usa en memoria (hashes y estimaciones) y no se persiste ni se loguea.
// Cambios: polling por TAMAÑO del log (en Windows el mtime de un archivo abierto se atrasa).

const NAME = 'desktop';
const LDB = 'https_claude.ai_0.indexeddb.leveldb';
const BLOB = 'https_claude.ai_0.indexeddb.blob';

export function desktopIdbDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.CONTEXTPILOT_DESKTOP_IDB_DIR) return [env.CONTEXTPILOT_DESKTOP_IDB_DIR];
  // Red de seguridad: los tests nunca leen el store real (hace falta una carpeta explícita).
  if (env.VITEST || process.env.VITEST) return [];
  const pk = join(env.LOCALAPPDATA ?? '', 'Packages');
  try {
    return readdirSync(pk)
      .filter((d) => /^Claude_/.test(d))
      .map((d) => join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'IndexedDB'));
  } catch {
    return [];
  }
}

export interface DesktopStoreOptions {
  pipeline: Pipeline;
  storage: Storage;
  health: HealthRegistry;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  /** Al arrancar, los turnos más viejos que esto se reprocesan sin publicar sugerencias. */
  recentMs: number;
}

export class DesktopStoreAdapter {
  private timer: NodeJS.Timeout | null = null;
  private dir: string | null = null;
  private logName = '';
  private logOffset = 0;
  private logSize = -1;
  private blobs = new Map<string, string>();
  /**
   * Carpetas de base de datos del .blob sin ninguna conversación tras la primera pasada completa
   * (p. ej. la caché de React Query, que se reescribe seguido): se dejan de revisar.
   */
  private otherDbs = new Set<string>();
  private first = true;
  private busy = false;
  private warnedFormat = '';

  constructor(private o: DesktopStoreOptions) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.o.pollMs ?? 2000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Una pasada (pública para tests). */
  tick(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      this.scan();
    } catch (e) {
      this.o.health.set(NAME, { status: 'error', detail: `lectura del store de Claude Desktop: ${(e as Error).message}` });
    } finally {
      this.busy = false;
    }
  }

  private scan(): void {
    this.dir ??= desktopIdbDirs(this.o.env).find((d) => existsSync(join(d, LDB))) ?? null;
    if (!this.dir) {
      this.o.health.set(NAME, { status: 'no-data', detail: 'no encontré el store de Claude Desktop (¿está instalado?)' });
      return;
    }
    const records = new Map<string, StoreRecord & { writtenAt?: number }>();
    const keep = (r: StoreRecord & { writtenAt?: number }) => {
      const cur = records.get(r.conversationUuid);
      if (!cur || (r.writtenAt ?? 0) >= (cur.writtenAt ?? 0)) records.set(r.conversationUuid, r);
    };
    const logChanged = this.readLogTail(keep);
    // Los blobs se escriben junto con un put en el log: sólo se revisan si el log cambió.
    if (logChanged || this.first) this.readBlobs(keep);
    this.ingest([...records.values()]);
    this.first = false;
  }

  private readLogTail(keep: (r: StoreRecord) => void): boolean {
    const ldb = join(this.dir!, LDB);
    const name = readdirSync(ldb).filter((n) => /^\d+\.log$/.test(n)).sort().at(-1);
    if (!name) return false;
    if (name !== this.logName) {
      this.logName = name;
      this.logOffset = 0;
      this.logSize = -1;
    }
    const size = statSync(join(ldb, name)).size;
    if (size === this.logSize) return false;
    this.logSize = size;
    if (size < this.logOffset) this.logOffset = 0;
    const len = size - this.logOffset;
    const buf = Buffer.alloc(len);
    const fd = openSync(join(ldb, name), 'r');
    try {
      readSync(fd, buf, 0, len, this.logOffset);
    } finally {
      closeSync(fd);
    }
    const r = readLog(buf, this.logOffset);
    this.logOffset = r.resumeAt;
    for (const p of r.puts) this.consider(p.value, keep);
    return true;
  }

  private readBlobs(keep: (r: StoreRecord) => void): void {
    const root = join(this.dir!, BLOB);
    if (!existsSync(root)) return;
    for (const db of readdirSync(root)) {
      if (this.otherDbs.has(db)) continue;
      const files: string[] = [];
      walk(join(root, db), files);
      let found = false;
      for (const f of files) {
        let st;
        try {
          st = statSync(f);
        } catch {
          continue;
        }
        const sig = `${st.size}:${st.mtimeMs}`;
        if (this.blobs.get(f) === sig) continue;
        this.blobs.set(f, sig);
        // Una misma base mezcla conversaciones con otros valores: nunca se descarta por un valor ajeno.
        if (this.consider(readFileSync(f), keep) === 'record') found = true;
      }
      if (this.first && !found && files.length) this.otherDbs.add(db);
    }
  }

  /** Decodifica un valor y guarda los registros con `tree`. */
  private consider(raw: Buffer, keep: (r: StoreRecord) => void): 'record' | 'other' | 'skip' {
    let v: unknown;
    try {
      v = decodeIdbValue(raw);
    } catch {
      return 'skip';
    }
    if (v === undefined) return 'skip';
    if (!isStoreRecord(v)) return v && typeof v === 'object' ? 'other' : 'skip';
    if (!v.tree) return 'record';
    if (v.v !== STORE_FORMAT) {
      const detail = `formato del store ${String(v.v)} no soportado (conocido: ${STORE_FORMAT}); no se informan cifras`;
      if (this.warnedFormat !== detail) this.o.log.warn(`desktop: ${detail}`);
      this.warnedFormat = detail;
      this.o.health.set(NAME, { status: 'error', detail, formatVersion: String(v.v) });
      return 'record';
    }
    keep(v);
    return 'record';
  }

  private ingest(records: StoreRecord[]): void {
    const cutoff = Date.now() - this.o.recentMs;
    const live: TurnEvent[] = [];
    const replay: TurnEvent[] = [];
    for (const rec of records) {
      const session = this.o.pipeline.getSession(desktopSessionId(rec.conversationUuid));
      // La captura CDP (si funciona) ya informa esta conversación: no se cuenta dos veces.
      if (session?.client === 'claude-desktop') continue;
      const drafts = turnsFromRecord(rec).filter((d) => !this.o.storage.hasTurn(d.id));
      if (!drafts.length) continue;
      let n = session?.turns ?? 0;
      for (const d of drafts) {
        const e = { ...d, turn: ++n } as TurnEvent;
        // Turnos viejos no publican avisos, también los de una conversación retomada más tarde.
        (Date.parse(e.ts) < cutoff ? replay : live).push(e);
      }
    }
    if (replay.length) this.o.pipeline.ingest(replay, { replay: true });
    if (live.length) this.o.pipeline.ingest(live);
    if (!replay.length && !live.length && this.first && this.o.health.get(NAME)?.status !== 'error') {
      this.o.health.set(NAME, { status: 'no-data', detail: 'store de Claude Desktop leído; sin turnos todavía' });
    }
  }
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
}
