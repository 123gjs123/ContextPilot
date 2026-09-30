import { existsSync, readFileSync, renameSync } from 'node:fs';
import initSqlJs from 'sql.js';
import type { Database, SqlValue } from 'sql.js';
import { effectiveTokens, rawTokens, type Feedback, type SessionState, type Suggestion, type TurnEvent } from '@contextpilot/core';
import { writeAtomic } from './paths.js';

// CP-023: almacenamiento sql.js (WASM, DECISIONS) volcado a cp.db con debounce y escritura atómica.
// RNF-01: sólo métricas, hashes y embeddings. El contenido sólo entra a la tabla `contents` si la
// fuente tiene opt-in (lo decide el llamador).

export const SCHEMA_VERSION = 1;
const SAVE_DELAY_MS = 1500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, source TEXT, provider TEXT, client TEXT, model TEXT,
  started_at TEXT, last_turn_at TEXT, last_turn_ms INTEGER, state_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL, turn INTEGER,
  phase TEXT, source TEXT, provider TEXT, client TEXT, model TEXT,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
  context_size INTEGER, context_window INTEGER, idle_ms INTEGER, estimated INTEGER, cache_ratio REAL,
  prompt_hash TEXT);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, ts_ms);
CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts_ms);
CREATE TABLE IF NOT EXISTS tool_calls (
  turn_id TEXT, session_id TEXT, ts_ms INTEGER, name TEXT, result_tokens INTEGER, failed INTEGER, args_hash TEXT);
CREATE INDEX IF NOT EXISTS tool_calls_ts ON tool_calls(ts_ms);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY, session_id TEXT, rule_id TEXT, severity TEXT, created_ms INTEGER, expires_ms INTEGER,
  estimated_saving INTEGER, quiet INTEGER, json TEXT, status TEXT DEFAULT 'open', feedback TEXT,
  feedback_ms INTEGER, surface TEXT);
CREATE INDEX IF NOT EXISTS suggestions_session ON suggestions(session_id, created_ms);
CREATE TABLE IF NOT EXISTS embeddings (turn_id TEXT PRIMARY KEY, session_id TEXT, ts_ms INTEGER, vector TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS offsets (path TEXT PRIMARY KEY, offset INTEGER, updated_ms INTEGER);
CREATE TABLE IF NOT EXISTS transcripts (session_id TEXT PRIMARY KEY, path TEXT, source TEXT, updated_ms INTEGER);
CREATE TABLE IF NOT EXISTS advisor_usage (ts_ms INTEGER, method TEXT, input INTEGER, output INTEGER, cost_usd REAL);
CREATE TABLE IF NOT EXISTS contents (session_id TEXT, ts_ms INTEGER, source TEXT, role TEXT, text TEXT);
`;

export interface TimelinePoint {
  ts: string;
  contextSize: number;
  cacheRatio: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  estimated: boolean;
}

export type StoredSuggestion = Suggestion & { feedback?: Feedback; status?: string };

export class Storage {
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  private constructor(
    private db: Database,
    private file: string | null,
  ) {}

  /** Abre (o crea) la base. Un archivo corrupto se aparta como `.corrupt-<ts>` y se empieza de cero. */
  static async open(file: string | null): Promise<Storage> {
    const SQL = await initSqlJs();
    let db: Database;
    if (file && existsSync(file)) {
      try {
        db = new SQL.Database(readFileSync(file));
        db.exec('SELECT count(*) FROM sqlite_master');
      } catch {
        renameSync(file, `${file}.corrupt-${Date.now()}`);
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
    }
    const s = new Storage(db, file);
    s.migrate();
    return s;
  }

  private migrate(): void {
    this.db.exec(SCHEMA);
    const cur = Number(this.getMeta('schema_version') ?? 0);
    if (cur < SCHEMA_VERSION) {
      // v1 es el primer esquema; futuras migraciones van acá, en orden.
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }
  }

  schemaVersion(): number {
    return Number(this.getMeta('schema_version') ?? 0);
  }

  // ---------- helpers ----------

  private all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T[] {
    const st = this.db.prepare(sql);
    try {
      st.bind(params);
      const out: T[] = [];
      while (st.step()) out.push(st.getAsObject() as T);
      return out;
    } finally {
      st.free();
    }
  }

  private one<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  private run(sql: string, params: SqlValue[] = []): number {
    this.db.run(sql, params);
    this.markDirty();
    return this.db.getRowsModified();
  }

  private getMeta(key: string): string | undefined {
    return this.one<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value;
  }

  private setMeta(key: string, value: string): void {
    this.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
  }

  // ---------- persistencia a disco ----------

  markDirty(): void {
    this.dirty = true;
    if (this.timer || !this.file || this.closed) return;
    // Retardo fijo desde la primera escritura (no se re-arma): garantiza volcado ≤ 5 s.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SAVE_DELAY_MS);
    this.timer.unref();
  }

  flush(): void {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    writeAtomic(this.file, this.db.export());
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
    this.closed = true;
    this.db.close();
  }

  // ---------- turnos ----------

  /** Inserta un turno. Devuelve false si el id ya existía (idempotencia de ingesta). */
  insertTurn(e: TurnEvent, cacheRatio: number | null): boolean {
    const t = e.tokens;
    const tsMs = Date.parse(e.ts);
    const n = this.run(
      `INSERT OR IGNORE INTO turns (id, session_id, ts, ts_ms, turn, phase, source, provider, client, model,
        input, output, cache_read, cache_write, reasoning, context_size, context_window, idle_ms, estimated,
        cache_ratio, prompt_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        e.id, e.sessionId, e.ts, tsMs, e.turn, e.phase ?? 'response', e.source, e.provider, e.client, e.model,
        t.input, t.output, t.cacheRead ?? 0, t.cacheWrite ?? 0, t.reasoning ?? 0,
        e.contextSize, e.contextWindow, e.idleSincePrevMs, t.estimated ? 1 : 0, cacheRatio, e.promptHash ?? '',
      ],
    );
    if (!n) return false;
    for (const tc of e.toolCalls ?? []) {
      this.run(
        'INSERT INTO tool_calls (turn_id, session_id, ts_ms, name, result_tokens, failed, args_hash) VALUES (?,?,?,?,?,?,?)',
        [e.id, e.sessionId, tsMs, tc.name, tc.resultTokens, tc.failed ? 1 : 0, tc.argsHash],
      );
    }
    if (e.promptEmbedding?.length) {
      this.run('INSERT OR REPLACE INTO embeddings (turn_id, session_id, ts_ms, vector) VALUES (?,?,?,?)', [
        e.id, e.sessionId, tsMs, JSON.stringify(e.promptEmbedding.map((x) => Math.round(x * 1e4) / 1e4)),
      ]);
    }
    return true;
  }

  hasTurn(id: string): boolean {
    return !!this.one('SELECT 1 AS x FROM turns WHERE id = ?', [id]);
  }

  timeline(sessionId: string, limit = 2000): TimelinePoint[] {
    return this.all<any>(
      `SELECT ts, context_size, cache_ratio, input, output, cache_read, cache_write, estimated FROM turns
       WHERE session_id = ? AND phase = 'response' ORDER BY ts_ms DESC LIMIT ?`,
      [sessionId, limit],
    )
      .reverse()
      .map((r) => ({
        ts: r.ts,
        contextSize: r.context_size,
        cacheRatio: r.cache_ratio ?? null,
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
        cacheWrite: r.cache_write,
        estimated: !!r.estimated,
      }));
  }

  /**
   * Puntos de consumo por proveedor desde `fromMs` (R10 local, /stats.burn). D-21: `tokens` = tokens
   * efectivos (input + cacheWrite + output + 0,1 × cacheRead, `effectiveTokens` del core); `raw` = suma cruda.
   */
  usagePoints(provider: string, fromMs: number): { ts: number; tokens: number; raw: number }[] {
    return this.all<any>(
      `SELECT ts_ms, input, output, cache_read, cache_write FROM turns
       WHERE provider = ? AND phase = 'response' AND ts_ms >= ? ORDER BY ts_ms`,
      [provider, fromMs],
    ).map((r) => {
      const t = { input: r.input ?? 0, output: r.output ?? 0, cacheRead: r.cache_read ?? 0, cacheWrite: r.cache_write ?? 0 };
      return { ts: r.ts_ms, tokens: effectiveTokens(t), raw: rawTokens(t) };
    });
  }

  // ---------- sesiones ----------

  saveSession(s: SessionState): void {
    this.run(
      `INSERT OR REPLACE INTO sessions (session_id, source, provider, client, model, started_at, last_turn_at,
        last_turn_ms, state_json) VALUES (?,?,?,?,?,?,?,?,?)`,
      [s.sessionId, s.source, s.provider, s.client, s.model, s.startedAt, s.lastTurnAt, Date.parse(s.lastTurnAt) || 0, JSON.stringify(s)],
    );
  }

  loadSessions(sinceMs = 0): SessionState[] {
    return this.all<{ state_json: string }>('SELECT state_json FROM sessions WHERE last_turn_ms >= ?', [sinceMs]).map(
      (r) => JSON.parse(r.state_json) as SessionState,
    );
  }

  loadSession(id: string): SessionState | undefined {
    const r = this.one<{ state_json: string }>('SELECT state_json FROM sessions WHERE session_id = ?', [id]);
    return r ? (JSON.parse(r.state_json) as SessionState) : undefined;
  }

  listSessions(limit = 200): SessionState[] {
    return this.all<{ state_json: string }>('SELECT state_json FROM sessions ORDER BY last_turn_ms DESC LIMIT ?', [limit]).map(
      (r) => JSON.parse(r.state_json) as SessionState,
    );
  }

  // ---------- sugerencias ----------

  insertSuggestion(s: Suggestion): void {
    this.run(
      `INSERT OR REPLACE INTO suggestions (id, session_id, rule_id, severity, created_ms, expires_ms, estimated_saving,
        quiet, json, status) VALUES (?,?,?,?,?,?,?,?,?, 'open')`,
      [
        s.id, s.sessionId, s.ruleId, s.severity, Date.parse(s.createdAt ?? '') || Date.now(), Date.parse(s.expiresAt),
        s.estimatedSavingTokens ?? 0, s.quiet ? 1 : 0, JSON.stringify(s),
      ],
    );
  }

  /**
   * D-22: renovación de una sugerencia de cuenta abierta (mismo id): vencimiento, severidad y texto.
   * No toca feedback ni estado; devuelve false si ya no estaba abierta.
   */
  refreshSuggestion(s: Suggestion): boolean {
    return (
      this.run("UPDATE suggestions SET severity = ?, expires_ms = ?, quiet = ?, json = ? WHERE id = ? AND status = 'open'", [
        s.severity, Date.parse(s.expiresAt), s.quiet ? 1 : 0, JSON.stringify(s), s.id,
      ]) > 0
    );
  }

  getSuggestion(id: string): StoredSuggestion | undefined {
    const r = this.one<any>('SELECT json, feedback, status FROM suggestions WHERE id = ?', [id]);
    return r ? rowToSuggestion(r) : undefined;
  }

  setFeedback(id: string, fb: Feedback, surface: string | undefined, now = Date.now()): boolean {
    return (
      this.run('UPDATE suggestions SET feedback = ?, feedback_ms = ?, surface = ?, status = ? WHERE id = ?', [
        fb, now, surface ?? null, fb, id,
      ]) > 0
    );
  }

  setStatus(id: string, status: 'expired' | 'superseded'): void {
    this.run("UPDATE suggestions SET status = ? WHERE id = ? AND status = 'open'", [status, id]);
  }

  listSuggestions(opts: { sessionId?: string; active?: boolean; now?: number; limit?: number }): StoredSuggestion[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (opts.sessionId) {
      where.push('session_id = ?');
      params.push(opts.sessionId);
    }
    if (opts.active) {
      where.push("status = 'open' AND expires_ms > ?");
      params.push(opts.now ?? Date.now());
    }
    params.push(opts.limit ?? 500);
    return this.all<any>(
      `SELECT json, feedback, status FROM suggestions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_ms DESC LIMIT ?`,
      params,
    ).map(rowToSuggestion);
  }

  /** Sugerencias abiertas no vencidas (para reprogramar vencimientos al arrancar). */
  openSuggestions(now = Date.now()): StoredSuggestion[] {
    return this.listSuggestions({ active: true, now, limit: 1000 });
  }

  // ---------- settings / offsets / transcripts ----------

  getSetting<T>(key: string): T | undefined {
    const r = this.one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  }

  getOffset(path: string): number | undefined {
    return this.one<{ offset: number }>('SELECT offset FROM offsets WHERE path = ?', [path])?.offset;
  }

  setOffset(path: string, offset: number): void {
    this.run('INSERT OR REPLACE INTO offsets (path, offset, updated_ms) VALUES (?,?,?)', [path, offset, Date.now()]);
  }

  setTranscript(sessionId: string, path: string, source: string): void {
    const cur = this.one<{ path: string }>('SELECT path FROM transcripts WHERE session_id = ?', [sessionId]);
    if (cur?.path === path) return;
    this.run('INSERT OR REPLACE INTO transcripts (session_id, path, source, updated_ms) VALUES (?,?,?,?)', [
      sessionId, path, source, Date.now(),
    ]);
  }

  getTranscript(sessionId: string): { path: string; source: string } | undefined {
    return this.one<{ path: string; source: string }>('SELECT path, source FROM transcripts WHERE session_id = ?', [sessionId]);
  }

  // ---------- contenido opt-in y consumo propio ----------

  insertContent(sessionId: string, source: string, role: string, text: string, tsMs = Date.now()): void {
    this.run('INSERT INTO contents (session_id, ts_ms, source, role, text) VALUES (?,?,?,?,?)', [sessionId, tsMs, source, role, text]);
  }

  recordAdvisorUsage(method: string, input: number, output: number, costUsd: number): void {
    this.run('INSERT INTO advisor_usage (ts_ms, method, input, output, cost_usd) VALUES (?,?,?,?,?)', [
      Date.now(), method, input, output, costUsd,
    ]);
  }

  // ---------- retención ----------

  /** CP-023.3: purga datos más viejos que `days`. Devuelve filas de turnos borradas. */
  purge(days: number, now = Date.now()): number {
    const cutoff = now - days * 86_400_000;
    const n = this.run('DELETE FROM turns WHERE ts_ms < ?', [cutoff]);
    this.run('DELETE FROM tool_calls WHERE ts_ms < ?', [cutoff]);
    this.run('DELETE FROM embeddings WHERE ts_ms < ?', [cutoff]);
    this.run('DELETE FROM suggestions WHERE created_ms < ?', [cutoff]);
    this.run('DELETE FROM contents WHERE ts_ms < ?', [cutoff]);
    this.run('DELETE FROM advisor_usage WHERE ts_ms < ?', [cutoff]);
    this.run('DELETE FROM sessions WHERE last_turn_ms < ?', [cutoff]);
    this.run('DELETE FROM transcripts WHERE updated_ms < ? AND session_id NOT IN (SELECT session_id FROM sessions)', [cutoff]);
    return n;
  }

  // ---------- estadísticas (CP-051 / GET /stats) ----------

  statsByRule(fromMs: number, toMs: number): any[] {
    return this.all(
      `SELECT rule_id AS ruleId, count(*) AS fired,
        sum(feedback = 'accepted') AS accepted, sum(feedback = 'dismissed') AS dismissed,
        sum(feedback = 'snoozed') AS snoozed,
        sum(CASE WHEN feedback = 'accepted' THEN estimated_saving ELSE 0 END) AS savedTokens
       FROM suggestions WHERE created_ms >= ? AND created_ms < ? GROUP BY rule_id ORDER BY fired DESC`,
      [fromMs, toMs],
    );
  }

  statsByProvider(fromMs: number, toMs: number): any[] {
    return this.all(
      `SELECT provider, count(DISTINCT session_id) AS sessions, sum(input) AS input, sum(output) AS output,
        sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite
       FROM turns WHERE phase = 'response' AND ts_ms >= ? AND ts_ms < ? GROUP BY provider`,
      [fromMs, toMs],
    );
  }

  savedByProvider(fromMs: number, toMs: number): Record<string, number> {
    const rows = this.all<any>(
      `SELECT s.provider AS provider, sum(g.estimated_saving) AS saved FROM suggestions g
       JOIN sessions s ON s.session_id = g.session_id
       WHERE g.feedback = 'accepted' AND g.created_ms >= ? AND g.created_ms < ? GROUP BY s.provider`,
      [fromMs, toMs],
    );
    return Object.fromEntries(rows.map((r) => [r.provider, r.saved ?? 0]));
  }

  activeHours(fromMs: number, toMs: number): number {
    return (
      this.one<{ n: number }>(
        'SELECT count(DISTINCT ts_ms / 3600000) AS n FROM turns WHERE ts_ms >= ? AND ts_ms < ?',
        [fromMs, toMs],
      )?.n ?? 0
    );
  }

  shownSuggestions(fromMs: number, toMs: number): number {
    return this.one<{ n: number }>('SELECT count(*) AS n FROM suggestions WHERE quiet = 0 AND created_ms >= ? AND created_ms < ?', [fromMs, toMs])?.n ?? 0;
  }

  advisorTotals(fromMs: number, toMs: number): { calls: number; input: number; output: number; costUsd: number } {
    const r = this.one<any>(
      `SELECT count(*) AS calls, coalesce(sum(input),0) AS input, coalesce(sum(output),0) AS output,
        coalesce(sum(cost_usd),0) AS costUsd FROM advisor_usage WHERE ts_ms >= ? AND ts_ms < ? AND method != 'extractive'`,
      [fromMs, toMs],
    );
    return { calls: r?.calls ?? 0, input: r?.input ?? 0, output: r?.output ?? 0, costUsd: r?.costUsd ?? 0 };
  }

  /** Filas para el agregado de equipo (sin contenido; el core descarta ids y hashes). */
  teamRows(fromMs: number, toMs: number): { sessions: SessionState[]; suggestions: StoredSuggestion[] } {
    const sessions = this.all<{ state_json: string }>('SELECT state_json FROM sessions WHERE last_turn_ms >= ?', [fromMs]).map(
      (r) => JSON.parse(r.state_json) as SessionState,
    );
    const suggestions = this.all<any>('SELECT json, feedback, status FROM suggestions WHERE created_ms >= ? AND created_ms < ?', [
      fromMs, toMs,
    ]).map(rowToSuggestion);
    return { sessions, suggestions };
  }

  /** Para tests de fuga: el binario exportado de la base. */
  exportBytes(): Uint8Array {
    return this.db.export();
  }
}

function rowToSuggestion(r: { json: string; feedback: string | null; status: string | null }): StoredSuggestion {
  const s = JSON.parse(r.json) as StoredSuggestion;
  if (r.feedback) s.feedback = r.feedback as Feedback;
  if (r.status) s.status = r.status;
  return s;
}
