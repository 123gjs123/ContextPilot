import type { Feedback, Provider } from './types.js';

// CP-057 / RF-TEAM-01 / DECISIONS «modo equipo»: agregados anónimos exportables a archivo.
// Garantías: sin sessionId, sin hashes, sin rutas ni nombres de proyecto, sin modelos de embedding.
// Sólo contadores por (semana ISO, proveedor) y (semana ISO, regla). Todo bucket con menos de
// MIN_BUCKET_SESSIONS sesiones distintas se suprime (k-anonimato mínimo).

export const MIN_BUCKET_SESSIONS = 5;
export const TEAM_SCHEMA = 'contextpilot.team/1';

/** Fila de sesión: acepta SessionState o una fila plana de la tabla `sessions`. */
export interface TeamSessionRow {
  sessionId: string;
  provider: Provider;
  startedAt?: string;
  lastTurnAt?: string;
  totals?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number };
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface TeamSuggestionRow {
  sessionId: string;
  ruleId: string;
  createdAt?: string;
  feedback?: Feedback | 'expired' | null;
  estimatedSavingTokens?: number;
}

export interface TeamProviderBucket {
  week: string;
  provider: Provider;
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  suggestions: number;
  accepted: number;
  dismissed: number;
  snoozed: number;
  savedTokens: number;
}

export interface TeamRuleBucket {
  week: string;
  ruleId: string;
  sessions: number;
  fired: number;
  accepted: number;
  dismissed: number;
  snoozed: number;
  acceptanceRate: number;
  savedTokens: number;
}

export interface TeamExport {
  schema: typeof TEAM_SCHEMA;
  generatedAt: string;
  minBucketSessions: number;
  /** Cantidad de exportaciones combinadas (1 si es local). */
  contributors: number;
  weeks: string[];
  byProvider: TeamProviderBucket[];
  byRule: TeamRuleBucket[];
  /** Buckets omitidos por tener menos de minBucketSessions sesiones. */
  suppressedBuckets: number;
}

/** Semana ISO 8601 ('2026-W40') en UTC. */
export function isoWeek(ts: string | number | Date): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function tokensOf(s: TeamSessionRow) {
  const t = s.totals;
  return {
    input: t?.input ?? s.input ?? 0,
    output: t?.output ?? s.output ?? 0,
    cacheRead: t?.cacheRead ?? s.cacheRead ?? 0,
    cacheWrite: t?.cacheWrite ?? s.cacheWrite ?? 0,
  };
}

const rate = (acc: number, fired: number) => (fired > 0 ? Math.round((acc / fired) * 1000) / 1000 : 0);

export function aggregateTeam(input: {
  sessions: TeamSessionRow[];
  suggestions: TeamSuggestionRow[];
  /** Filtro opcional por fecha de inicio de sesión (ISO, inclusive). */
  from?: string;
  to?: string;
  minBucketSessions?: number;
  now?: number;
}): TeamExport {
  const min = input.minBucketSessions ?? MIN_BUCKET_SESSIONS;
  const from = input.from ? Date.parse(input.from) : -Infinity;
  const to = input.to ? Date.parse(input.to) : Infinity;

  // Sesión → (semana, proveedor). Las ids se usan sólo en memoria para contar distintas.
  const sessionInfo = new Map<string, { week: string; provider: Provider }>();
  const provAcc = new Map<string, { b: TeamProviderBucket; ids: Set<string> }>();
  for (const s of input.sessions) {
    const when = s.startedAt ?? s.lastTurnAt;
    const ms = when ? Date.parse(when) : NaN;
    if (Number.isNaN(ms) || ms < from || ms > to) continue;
    const week = isoWeek(ms);
    sessionInfo.set(s.sessionId, { week, provider: s.provider });
    const key = `${week}|${s.provider}`;
    let a = provAcc.get(key);
    if (!a) {
      a = {
        b: { week, provider: s.provider, sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, suggestions: 0, accepted: 0, dismissed: 0, snoozed: 0, savedTokens: 0 },
        ids: new Set(),
      };
      provAcc.set(key, a);
    }
    if (!a.ids.has(s.sessionId)) {
      a.ids.add(s.sessionId);
      const t = tokensOf(s);
      a.b.input += t.input;
      a.b.output += t.output;
      a.b.cacheRead += t.cacheRead;
      a.b.cacheWrite += t.cacheWrite;
    }
  }

  const ruleAcc = new Map<string, { b: TeamRuleBucket; ids: Set<string> }>();
  for (const sg of input.suggestions) {
    const info = sessionInfo.get(sg.sessionId);
    if (!info) continue; // sesión fuera de rango o desconocida
    const p = provAcc.get(`${info.week}|${info.provider}`)!;
    const key = `${info.week}|${sg.ruleId}`;
    let r = ruleAcc.get(key);
    if (!r) {
      r = { b: { week: info.week, ruleId: sg.ruleId, sessions: 0, fired: 0, accepted: 0, dismissed: 0, snoozed: 0, acceptanceRate: 0, savedTokens: 0 }, ids: new Set() };
      ruleAcc.set(key, r);
    }
    r.ids.add(sg.sessionId);
    r.b.fired += 1;
    p.b.suggestions += 1;
    if (sg.feedback === 'accepted') {
      const saved = Math.max(0, sg.estimatedSavingTokens ?? 0);
      r.b.accepted += 1;
      r.b.savedTokens += saved;
      p.b.accepted += 1;
      p.b.savedTokens += saved;
    } else if (sg.feedback === 'dismissed') {
      r.b.dismissed += 1;
      p.b.dismissed += 1;
    } else if (sg.feedback === 'snoozed') {
      r.b.snoozed += 1;
      p.b.snoozed += 1;
    }
  }

  let suppressed = 0;
  const byProvider: TeamProviderBucket[] = [];
  for (const { b, ids } of provAcc.values()) {
    if (ids.size < min) {
      suppressed++;
      continue;
    }
    byProvider.push({ ...b, sessions: ids.size });
  }
  const byRule: TeamRuleBucket[] = [];
  for (const { b, ids } of ruleAcc.values()) {
    if (ids.size < min) {
      suppressed++;
      continue;
    }
    byRule.push({ ...b, sessions: ids.size, acceptanceRate: rate(b.accepted, b.fired) });
  }
  return finish({ byProvider, byRule, suppressedBuckets: suppressed, contributors: 1, min, now: input.now });
}

function finish(x: {
  byProvider: TeamProviderBucket[];
  byRule: TeamRuleBucket[];
  suppressedBuckets: number;
  contributors: number;
  min: number;
  now?: number;
}): TeamExport {
  x.byProvider.sort((a, b) => a.week.localeCompare(b.week) || a.provider.localeCompare(b.provider));
  x.byRule.sort((a, b) => a.week.localeCompare(b.week) || a.ruleId.localeCompare(b.ruleId));
  const weeks = [...new Set([...x.byProvider.map((b) => b.week), ...x.byRule.map((b) => b.week)])].sort();
  return {
    schema: TEAM_SCHEMA,
    // Sólo precisión de día: no identifica el momento exacto de la exportación.
    generatedAt: new Date(x.now ?? Date.now()).toISOString().slice(0, 10),
    minBucketSessions: x.min,
    contributors: x.contributors,
    weeks,
    byProvider: x.byProvider,
    byRule: x.byRule,
    suppressedBuckets: x.suppressedBuckets,
  };
}

/** Combina N exportaciones (dashboard, sin servidor). Suma buckets de igual clave. */
export function mergeTeamExports(exports: TeamExport[], now?: number): TeamExport {
  const prov = new Map<string, TeamProviderBucket>();
  const rules = new Map<string, TeamRuleBucket>();
  let suppressed = 0;
  let contributors = 0;
  let min = MIN_BUCKET_SESSIONS;
  for (const e of exports) {
    if (!e || e.schema !== TEAM_SCHEMA) continue;
    contributors += e.contributors ?? 1;
    suppressed += e.suppressedBuckets ?? 0;
    min = Math.max(min, e.minBucketSessions ?? MIN_BUCKET_SESSIONS);
    for (const b of e.byProvider ?? []) {
      const k = `${b.week}|${b.provider}`;
      const cur = prov.get(k);
      if (!cur) prov.set(k, { ...b });
      else
        for (const f of ['sessions', 'input', 'output', 'cacheRead', 'cacheWrite', 'suggestions', 'accepted', 'dismissed', 'snoozed', 'savedTokens'] as const)
          cur[f] += b[f];
    }
    for (const b of e.byRule ?? []) {
      const k = `${b.week}|${b.ruleId}`;
      const cur = rules.get(k);
      if (!cur) rules.set(k, { ...b });
      else for (const f of ['sessions', 'fired', 'accepted', 'dismissed', 'snoozed', 'savedTokens'] as const) cur[f] += b[f];
    }
  }
  const byRule = [...rules.values()].map((b) => ({ ...b, acceptanceRate: rate(b.accepted, b.fired) }));
  return finish({ byProvider: [...prov.values()], byRule, suppressedBuckets: suppressed, contributors, min, now });
}
