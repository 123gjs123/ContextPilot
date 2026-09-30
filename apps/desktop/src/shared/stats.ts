import { fmtPct, fmtTokens } from '@contextpilot/core';
import type { SessionView, Stats } from './types.js';

// View-models del dashboard (CP-051) y filtros de sesiones (CP-050.3). Puros.

export interface Kpi {
  label: string;
  value: string;
  target: string;
  status: 'ok' | 'bad' | 'none';
}

export interface RuleRow {
  ruleId: string;
  fired: number;
  accepted: number;
  dismissed: number;
  snoozed: number;
  acceptanceText: string;
  savedText: string;
  savedTokens: number;
}

export interface ProviderRow {
  provider: string;
  sessions: number;
  inputText: string;
  outputText: string;
  cacheText: string;
  savedText: string;
  savedTokens: number;
}

export interface StatsView {
  kpis: Kpi[];
  rules: RuleRow[];
  providers: ProviderRow[];
  totalSavedTokens: number;
  maxRuleSaved: number;
  maxProviderSaved: number;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export function statsView(st: Stats): StatsView {
  const rules: RuleRow[] = [...st.byRule]
    .sort((a, b) => b.fired - a.fired || a.ruleId.localeCompare(b.ruleId))
    .map((r) => {
      const answered = r.accepted + r.dismissed + r.snoozed;
      const acc = ratio(r.accepted, answered);
      return {
        ruleId: r.ruleId,
        fired: r.fired,
        accepted: r.accepted,
        dismissed: r.dismissed,
        snoozed: r.snoozed,
        acceptanceText: acc === null ? '—' : fmtPct(acc),
        savedText: `≈${fmtTokens(r.savedTokens)}`,
        savedTokens: r.savedTokens,
      };
    });
  const providers: ProviderRow[] = [...st.byProvider]
    .sort((a, b) => b.savedTokens - a.savedTokens)
    .map((p) => {
      const cache = ratio(p.cacheRead, p.input + p.cacheRead + p.cacheWrite);
      return {
        provider: p.provider,
        sessions: p.sessions,
        inputText: fmtTokens(p.input + p.cacheRead + p.cacheWrite),
        outputText: fmtTokens(p.output),
        cacheText: cache === null ? '—' : fmtPct(cache),
        savedText: `≈${fmtTokens(p.savedTokens)}`,
        savedTokens: p.savedTokens,
      };
    });
  const totalSaved = st.byRule.reduce((a, r) => a + r.savedTokens, 0);
  const totalFired = st.byRule.reduce((a, r) => a + r.fired, 0);
  const allIn = st.byProvider.reduce((a, p) => a + p.input + p.cacheRead + p.cacheWrite, 0);
  const allCache = st.byProvider.reduce((a, p) => a + p.cacheRead, 0);
  const cacheAll = ratio(allCache, allIn);

  const kpis: Kpi[] = [
    {
      label: 'Aceptación',
      value: totalFired ? fmtPct(st.acceptanceRate) : '—',
      target: '> 40 %',
      status: totalFired ? (st.acceptanceRate > 0.4 ? 'ok' : 'bad') : 'none',
    },
    {
      label: 'Sugerencias por hora activa',
      value: Number.isFinite(st.suggestionsPerActiveHour) ? st.suggestionsPerActiveHour.toFixed(1) : '—',
      target: '≤ 3',
      status: Number.isFinite(st.suggestionsPerActiveHour) ? (st.suggestionsPerActiveHour <= 3 ? 'ok' : 'bad') : 'none',
    },
    {
      label: 'Proporción de caché',
      value: cacheAll === null ? '—' : fmtPct(cacheAll),
      target: '> 80 % (CLI)',
      status: cacheAll === null ? 'none' : cacheAll > 0.8 ? 'ok' : 'bad',
    },
    {
      label: 'Ahorro estimado',
      value: `≈${fmtTokens(totalSaved)} tokens`,
      target: 'sólo aceptadas',
      status: 'none',
    },
    advisorKpi(st.advisorTokens, totalSaved),
  ];
  return {
    kpis,
    rules,
    providers,
    totalSavedTokens: totalSaved,
    maxRuleSaved: Math.max(0, ...rules.map((r) => r.savedTokens)),
    maxProviderSaved: Math.max(0, ...providers.map((p) => p.savedTokens)),
  };
}

/** CP-051.2 / RNF-14: consumo del asesor / ahorro; rojo si ≥ 2 %. */
export function advisorKpi(advisorTokens: number | undefined, savedTokens: number): Kpi {
  if (advisorTokens === undefined) return { label: 'Consumo del asesor / ahorro', value: 'sin datos', target: '< 2 %', status: 'none' };
  if (savedTokens <= 0) {
    return { label: 'Consumo del asesor / ahorro', value: advisorTokens > 0 ? '∞' : '0%', target: '< 2 %', status: advisorTokens > 0 ? 'bad' : 'ok' };
  }
  const r = advisorTokens / savedTokens;
  return { label: 'Consumo del asesor / ahorro', value: `${(r * 100).toFixed(1)}%`, target: '< 2 %', status: r >= 0.02 ? 'bad' : 'ok' };
}

export interface SessionFilter {
  provider?: string;
  source?: string;
  /** yyyy-mm-dd inclusive (hora local). */
  from?: string;
  to?: string;
}

function localDayStart(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, day ?? 1).getTime();
}

export function filterSessions(sessions: SessionView[], f: SessionFilter): SessionView[] {
  const from = f.from ? localDayStart(f.from) : -Infinity;
  const to = f.to ? localDayStart(f.to) + 86_400_000 : Infinity;
  return sessions
    .filter((s) => !f.provider || s.provider === f.provider)
    .filter((s) => !f.source || s.source === f.source)
    .filter((s) => {
      const t = Date.parse(s.lastTurnAt);
      return !Number.isFinite(t) || (t >= from && t < to);
    })
    .sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt));
}

export function distinct<T>(xs: T[]): T[] {
  return [...new Set(xs)].sort();
}

/** Query string para `GET /stats?from=&to=` (ISO). */
export function statsQuery(f: SessionFilter): string {
  const q = new URLSearchParams();
  if (f.from) q.set('from', new Date(localDayStart(f.from)).toISOString());
  if (f.to) q.set('to', new Date(localDayStart(f.to) + 86_400_000).toISOString());
  const s = q.toString();
  return s ? `?${s}` : '';
}
