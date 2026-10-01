import { coachingFor, fmtPct, fmtTokens, prettyServerName, ruleName, tipFor, type Coaching } from '@contextpilot/core';
import type { AccountRow, AppSnapshot, SessionRow, SuggestionRow } from './types.js';
import { meterLevel } from './view.js';

// CP-059: view-model del monitor «En vivo» (una tarjeta por sesión activa). Puro: se testea sin DOM.

/** Estado de alerta de la tarjeta: verde ok, ámbar warn, rojo critical, gris sin datos. */
export type CardState = 'ok' | 'warn' | 'critical' | 'nodata';

export const CARD_STATE_LABEL: Record<CardState, string> = {
  ok: 'En orden',
  warn: 'Atención',
  critical: 'Acción sugerida',
  nodata: 'Sin datos',
};

/** Color por estado (nombre del token CSS `--state-<color>`). */
export const CARD_STATE_COLOR: Record<CardState, 'green' | 'amber' | 'red' | 'gray'> = {
  ok: 'green',
  warn: 'amber',
  critical: 'red',
  nodata: 'gray',
};

const RANK: Record<CardState, number> = { nodata: 0, ok: 1, warn: 2, critical: 3 };
// Toda buena práctica recomendada vigente pone la tarjeta en rojo, sea cual sea su severidad.
const SEVERITY_STATE: Record<SuggestionRow['severity'], CardState> = { info: 'critical', warn: 'critical', critical: 'critical' };
const METER_STATE = { green: 'ok', yellow: 'warn', red: 'critical' } as const;

/**
 * Estado de la tarjeta = el peor entre el medidor de contexto (SPEC §9: < 50 % verde, 50–75 %
 * ámbar, > 75 % rojo) y la sugerencia vigente. Mismo criterio que
 * el color del tray. Cualquier sugerencia vigente → rojo. Sin datos (adaptador roto o sin ventana y sin sugerencia) → gris.
 */
export function cardState(r: Pick<SessionRow, 'noData' | 'contextPct'> & { suggestion?: Pick<SuggestionRow, 'severity'> }, contextWindow: number): CardState {
  if (r.noData) return 'nodata';
  const fromMeter: CardState | null = contextWindow && r.contextPct !== null ? METER_STATE[meterLevel(r.contextPct)] : null;
  const fromSug: CardState | null = r.suggestion ? SEVERITY_STATE[r.suggestion.severity] : null;
  if (!fromMeter && !fromSug) return 'nodata';
  const a = fromMeter ?? 'ok';
  const b = fromSug ?? 'ok';
  return RANK[b] > RANK[a] ? b : a;
}

/** «ahora», «hace 2 min», «hace 3 h». */
export function relTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'ahora';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export interface SourceBadge {
  /** Texto corto del distintivo (2–3 letras). */
  short: string;
  label: string;
}

export const SOURCE_BADGE: Record<string, SourceBadge> = {
  'claude-code': { short: 'CC', label: 'Claude Code' },
  codex: { short: 'CX', label: 'Codex CLI' },
  'gemini-cli': { short: 'GC', label: 'Gemini CLI' },
  proxy: { short: 'PX', label: 'Proxy (API)' },
  web: { short: 'WEB', label: 'Web' },
  desktop: { short: 'CD', label: 'Claude Desktop' },
};

export const PROVIDER_NAME: Record<string, string> = { anthropic: 'Claude', openai: 'OpenAI', google: 'Gemini' };

export interface CardCoaching extends Coaching {
  suggestionId: string;
  ruleId: string;
  ruleName: string;
  severity: SuggestionRow['severity'];
  title: string;
  savingText?: string;
  actions: SuggestionRow['actions'];
}

export interface LiveCard {
  sessionId: string;
  name: string;
  shortId: string;
  source: string;
  provider: string;
  badge: SourceBadge;
  model: string;
  state: CardState;
  stateLabel: string;
  color: (typeof CARD_STATE_COLOR)[CardState];
  /** Contexto: % (0..1) para la barra, texto («≈45 %» / «sin datos») y tokens. */
  ctxPct: number | null;
  ctxText: string;
  ctxTokensText: string;
  ctxLevel: 'green' | 'yellow' | 'red' | 'none';
  cacheText: string;
  turnsText: string;
  burnText: string;
  lastText: string;
  coaching?: CardCoaching;
  tip: string | null;
  /** R6/R11: servidores MCP desactivados por ContextPilot en el proyecto (con botón «Reactivar»). */
  mcpDisabled: { key: string; name: string }[];
}

/** Adaptador sin datos: no se muestran cifras ni consejos inventados. */
export const NO_DATA_TIP = 'El adaptador de esta fuente no está informando datos: las cifras pueden estar desactualizadas. Revisá «Salud de adaptadores» en Sesiones.';

/** Tarjeta de una sesión activa. `now` fija el «hace…», la cuenta regresiva y la rotación de consejos. */
export function liveCard(r: SessionRow, now: number): LiveCard {
  const v = r.view;
  const state = cardState(r, v.contextWindow);
  const est = v.estimated ? '≈' : '';
  const sug = r.suggestion;
  const coaching: CardCoaching | undefined = sug
    ? {
        ...coachingFor(sug.ruleId, { view: v, suggestion: sug, now }),
        suggestionId: sug.id,
        ruleId: sug.ruleId,
        ruleName: ruleName(sug.ruleId),
        severity: sug.severity,
        title: sug.title,
        savingText: sug.savingText,
        actions: sug.actions,
      }
    : undefined;
  return {
    sessionId: r.sessionId,
    name: r.label,
    shortId: r.shortId,
    source: r.source,
    provider: r.provider,
    badge: SOURCE_BADGE[r.source] ?? { short: r.source.slice(0, 3).toUpperCase(), label: r.source },
    model: r.model || '—',
    state,
    stateLabel: coaching && state === 'critical' ? 'Buena práctica recomendada' : CARD_STATE_LABEL[state],
    color: CARD_STATE_COLOR[state],
    ctxPct: r.contextPct,
    ctxText: r.meterText,
    ctxTokensText: r.noData || !v.contextWindow ? '' : `${est}${fmtTokens(v.contextSize)} / ${fmtTokens(v.contextWindow)}`,
    ctxLevel: r.meterLevel,
    cacheText: r.noData || v.cachePct === null ? '—' : `${est}${fmtPct(v.cachePct)}`,
    turnsText: String(v.turns),
    burnText: v.burn && v.burn.tokensPerMin > 0 ? `${v.burn.estimated ? '≈' : ''}${fmtTokens(v.burn.tokensPerMin)}/min` : '—',
    lastText: relTime(v.lastTurnAt, now),
    coaching,
    mcpDisabled: (v.mcpDisabled ?? []).map((key) => ({ key, name: prettyServerName(key) })),
    // Sin sugerencia vigente: consejo contextual (rota; lo urgente gana).
    tip: coaching ? null : r.noData ? NO_DATA_TIP : tipFor(v, now),
  };
}

/**
 * Orden estable de las tarjetas: las que ya estaban conservan su lugar (no saltan con cada evento);
 * las nuevas entran adelante; las que dejan de estar activas salen.
 */
export function stableOrder(prev: string[], ids: string[]): string[] {
  const present = new Set(ids);
  const kept = prev.filter((id) => present.has(id));
  const known = new Set(kept);
  const fresh = ids.filter((id) => !known.has(id));
  return [...fresh, ...kept];
}

export interface PlanBar {
  label: string;
  pct: number;
  text: string;
  level: 'green' | 'yellow' | 'red';
}

export interface AccountStrip {
  /** Uso del plan de Claude (Claude Desktop), si hay. */
  plan?: { bars: PlanBar[]; stale: boolean; sampledText: string };
  /** R10 vigente por proveedor. */
  warnings: { provider: string; providerName: string; severity: SuggestionRow['severity']; title: string; detail: string; suggestionId: string; actions: SuggestionRow['actions'] }[];
}

/** CP-059: franja de cuenta (barras 5 h / 7 d y aviso R10). */
export function accountStrip(snap: Pick<AppSnapshot, 'planUsage' | 'account'>, now: number): AccountStrip {
  const out: AccountStrip = { warnings: [] };
  const p = snap.planUsage;
  if (p) {
    const bar = (label: string, pct: number): PlanBar => ({ label, pct, text: fmtPct(pct), level: meterLevel(pct) });
    out.plan = {
      bars: [bar('Ventana de 5 h', p.fiveHourPct), bar('Ventana de 7 días', p.sevenDayPct)],
      stale: p.stale,
      sampledText: relTime(p.sampledAt, now),
    };
  }
  for (const a of snap.account ?? []) out.warnings.push(accountWarning(a));
  return out;
}

function accountWarning(a: AccountRow): AccountStrip['warnings'][number] {
  return {
    provider: a.provider,
    providerName: PROVIDER_NAME[a.provider] ?? a.provider,
    severity: a.suggestion.severity,
    title: a.suggestion.title,
    detail: a.suggestion.detail,
    suggestionId: a.suggestion.id,
    actions: a.suggestion.actions,
  };
}

/** Firma para no redibujar una tarjeta que no cambió (conserva el foco del teclado y las transiciones). */
export function cardSignature(c: LiveCard): string {
  return JSON.stringify(c);
}
