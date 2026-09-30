// CP-057.1 / D-12: lógica de scripts/team-export.mjs (export semanal agregado y anónimo del modo equipo).
// Online: GET /team/export del daemon (token del directorio de datos). Offline: lee cp.db con sql.js y
// agrega con aggregateTeam del core (misma proyección que Daemon.teamExport). En ambos casos el
// resultado pasa por teamLeakCheck antes de escribirse.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateTeam, isoWeek, TEAM_SCHEMA, type TeamExport, type TeamSessionRow, type TeamSuggestionRow } from '../../packages/core/src/index.ts';
// @ts-ignore — módulo JS sin tipos (utilidades compartidas de los scripts)
import { cpBase, cpHome, cpToken } from './cp.mjs';

const DAY = 86_400_000;

/** Rango [from, to) en ms UTC de una semana ISO 'YYYY-Www' (default: la semana ISO actual). */
export function weekRange(week?: string, now = Date.now()): { week: string; from: number; to: number } {
  const w = week ?? isoWeek(now);
  const m = /^(\d{4})-W(\d{2})$/.exec(w);
  if (!m) throw new Error(`semana inválida: ${w} (formato YYYY-Www, p. ej. 2026-W40)`);
  const year = Number(m[1]);
  const n = Number(m[2]);
  // El 4 de enero siempre cae en la semana 1.
  const jan4 = Date.UTC(year, 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  const monday1 = jan4 - (dow - 1) * DAY;
  const from = monday1 + (n - 1) * 7 * DAY;
  if (n < 1 || isoWeek(from) !== w) throw new Error(`semana inexistente: ${w}`);
  return { week: w, from, to: from + 7 * DAY };
}

// ---------------------------------------------------------------------------------------------
// Test de fuga (CP-057.2). El core lo tiene sólo como test (team.test.ts); acá se aplica al archivo real.

const PROVIDER_KEYS = ['week', 'provider', 'sessions', 'input', 'output', 'cacheRead', 'cacheWrite', 'suggestions', 'accepted', 'dismissed', 'snoozed', 'savedTokens'];
const RULE_KEYS = ['week', 'ruleId', 'sessions', 'fired', 'accepted', 'dismissed', 'snoozed', 'acceptanceRate', 'savedTokens'];
const TOP_KEYS = ['schema', 'generatedAt', 'minBucketSessions', 'contributors', 'weeks', 'byProvider', 'byRule', 'suppressedBuckets'];

export interface LeakResult {
  ok: boolean;
  problems: string[];
}

export function teamLeakCheck(exp: unknown, forbidden: string[] = []): LeakResult {
  const problems: string[] = [];
  const json = JSON.stringify(exp);
  if (/[0-9a-f]{16,}/i.test(json)) problems.push('cadena hex ≥ 16 (hash)');
  if (/[0-9A-HJKMNP-TV-Z]{26}/.test(json)) problems.push('ULID');
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(json)) problems.push('UUID');
  if (/[\\/]{1,2}(Users|home)[\\/]|[A-Za-z]:[\\/]/.test(json)) problems.push('ruta');
  if (/sessionId|session_id|promptHash|argsHash|embedding/i.test(json)) problems.push('campo identificador');
  for (const f of forbidden) if (f && f.length >= 6 && json.includes(f)) problems.push(`contiene un valor prohibido (${f.slice(0, 4)}…)`);
  // Esquema cerrado: sólo las claves de TeamExport.
  const e = exp as Partial<TeamExport> | null;
  if (!e || typeof e !== 'object') problems.push('no es un objeto');
  else {
    if (e.schema !== TEAM_SCHEMA) problems.push(`schema ≠ ${TEAM_SCHEMA}`);
    const extra = (o: object, allowed: string[], where: string) => {
      for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`clave no permitida ${where}.${k}`);
    };
    extra(e, TOP_KEYS, '$');
    (e.byProvider ?? []).forEach((b, i) => extra(b, PROVIDER_KEYS, `byProvider[${i}]`));
    (e.byRule ?? []).forEach((b, i) => extra(b, RULE_KEYS, `byRule[${i}]`));
    const min = e.minBucketSessions ?? 5;
    for (const b of [...(e.byProvider ?? []), ...(e.byRule ?? [])]) if (b.sessions < min) problems.push(`bucket con ${b.sessions} < ${min} sesiones`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

// ---------------------------------------------------------------------------------------------
// Fuentes.

export async function fetchOnline(from: number, to: number, env: NodeJS.ProcessEnv = process.env, timeoutMs = 5000): Promise<TeamExport> {
  const token = cpToken(env);
  if (!token) throw new Error(`no hay token en ${join(cpHome(env), 'token')} (¿el daemon arrancó alguna vez?)`);
  const url = `${cpBase(env)}/team/export?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'X-CP-Token': token }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`daemon no disponible en ${cpBase(env)} (${(e as Error).message}); usar --offline`);
  }
  if (!res.ok) throw new Error(`GET /team/export → HTTP ${res.status}`);
  return (await res.json()) as TeamExport;
}

export interface OfflineRows {
  sessions: TeamSessionRow[];
  suggestions: TeamSuggestionRow[];
}

/** Lee cp.db (sql.js, sólo lectura en memoria) con la misma proyección que Storage.teamRows. */
export async function readDb(dbPath: string, from: number, to: number): Promise<OfflineRows> {
  if (!existsSync(dbPath)) throw new Error(`no existe ${dbPath}`);
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync(dbPath));
  try {
    const all = (sql: string, params: (number | string)[]) => {
      const st = db.prepare(sql);
      st.bind(params);
      const rows: any[] = [];
      while (st.step()) rows.push(st.getAsObject());
      st.free();
      return rows;
    };
    const sessions = all('SELECT state_json FROM sessions WHERE last_turn_ms >= ?', [from]).map((r) => JSON.parse(String(r.state_json)) as TeamSessionRow);
    const suggestions = all('SELECT json, feedback, status FROM suggestions WHERE created_ms >= ? AND created_ms < ?', [from, to]).map((r) => {
      const s = JSON.parse(String(r.json));
      const feedback = r.feedback ?? s.feedback ?? (r.status === 'expired' ? 'expired' : null);
      return { sessionId: s.sessionId, ruleId: s.ruleId, createdAt: s.createdAt, feedback, estimatedSavingTokens: s.estimatedSavingTokens } as TeamSuggestionRow;
    });
    return { sessions, suggestions };
  } finally {
    db.close();
  }
}

export async function exportOffline(dbPath: string, from: number, to: number, now = Date.now()): Promise<{ exp: TeamExport; forbidden: string[] }> {
  const rows = await readDb(dbPath, from, to);
  const exp = aggregateTeam({ ...rows, from: new Date(from).toISOString(), to: new Date(to).toISOString(), now });
  return { exp, forbidden: forbiddenStrings(rows) };
}

/** Todo string de las filas de origen (ids, modelos, clientes, fechas completas...) que no debe aparecer. */
export function forbiddenStrings(rows: OfflineRows): string[] {
  const out = new Set<string>();
  const PROVIDERS = new Set(['anthropic', 'openai', 'google']);
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.length >= 8 && !PROVIDERS.has(v)) out.add(v);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  rows.sessions.forEach(visit);
  rows.suggestions.forEach((s) => visit(s.sessionId));
  return [...out];
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cpHome(env), 'cp.db');
}
