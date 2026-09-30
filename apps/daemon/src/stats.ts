import type { Storage } from './storage.js';

// GET /stats (CP-051): agregados por regla y proveedor sobre la base local.

export interface Stats {
  byRule: { ruleId: string; fired: number; accepted: number; dismissed: number; snoozed: number; savedTokens: number }[];
  byProvider: { provider: string; sessions: number; input: number; output: number; cacheRead: number; cacheWrite: number; savedTokens: number }[];
  acceptanceRate: number;
  suggestionsPerActiveHour: number;
  /** Extensión RNF-14: consumo propio del asesor (traspasos con modelo) y cociente contra el ahorro. */
  advisor: { calls: number; input: number; output: number; costUsd: number; ratioToSaved: number | null };
  /** Tokens gastados por el propio asesor en traspasos con modelo (RNF-14). */
  advisorTokens: number;
  /** Último uso del plan informado por Claude Desktop (fracciones 0..1), si hay. */
  planUsage?: { fiveHourPct: number; sevenDayPct: number; ts: string; stale: boolean };
}

export function computeStats(storage: Storage, fromMs: number, toMs: number): Stats {
  const n = (x: unknown) => Number(x ?? 0);
  const byRule = storage.statsByRule(fromMs, toMs).map((r) => ({
    ruleId: String(r.ruleId),
    fired: n(r.fired),
    accepted: n(r.accepted),
    dismissed: n(r.dismissed),
    snoozed: n(r.snoozed),
    savedTokens: n(r.savedTokens),
  }));
  const saved = storage.savedByProvider(fromMs, toMs);
  const byProvider = storage.statsByProvider(fromMs, toMs).map((r) => ({
    provider: String(r.provider),
    sessions: n(r.sessions),
    input: n(r.input),
    output: n(r.output),
    cacheRead: n(r.cacheRead),
    cacheWrite: n(r.cacheWrite),
    savedTokens: n(saved[String(r.provider)]),
  }));
  const fired = byRule.reduce((s, r) => s + r.fired, 0);
  const accepted = byRule.reduce((s, r) => s + r.accepted, 0);
  const hours = storage.activeHours(fromMs, toMs);
  const advisor = storage.advisorTotals(fromMs, toMs);
  const savedTotal = byRule.reduce((s, r) => s + r.savedTokens, 0);
  return {
    byRule,
    byProvider,
    acceptanceRate: fired ? accepted / fired : 0,
    suggestionsPerActiveHour: hours ? storage.shownSuggestions(fromMs, toMs) / hours : 0,
    advisor: { ...advisor, ratioToSaved: savedTotal ? (advisor.input + advisor.output) / savedTotal : null },
    advisorTokens: advisor.input + advisor.output,
  };
}

/** Rango de fechas de query (`from`/`to` ISO o epoch ms). Default: últimos 7 días. */
export function parseRange(from: string | null, to: string | null, now = Date.now()): { from: number; to: number } {
  const p = (s: string | null) => {
    if (!s) return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : Date.parse(s);
  };
  const t = p(to);
  const f = p(from);
  const toMs = Number.isFinite(t) ? t : now + 1;
  return { from: Number.isFinite(f) ? f : toMs - 7 * 86_400_000, to: toMs };
}
