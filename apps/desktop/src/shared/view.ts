import { fmtPct, fmtTokens, sessionNameOf } from '@contextpilot/core';
import { activeSessions, visibleSuggestion, type DesktopState } from './store.js';
import type { AccountRow, AdapterHealth, SessionRow, SessionView, Suggestion, SuggestionRow, TrayColor } from './types.js';

// View-models del tray y del overlay (CP-046). Puros: se testean sin Electron.

/** Medidor SPEC §9: verde < 50 %, amarillo 50–75 %, rojo > 75 %. */
export function meterLevel(pct: number): 'green' | 'yellow' | 'red' {
  if (pct > 0.75) return 'red';
  if (pct >= 0.5) return 'yellow';
  return 'green';
}

/**
 * Adaptador responsable de una sesión. Convención asumida: `AdapterHealth.name` coincide con la
 * fuente (`claude-code`, `codex`, `gemini-cli`, `proxy`, `web`, `desktop`) o empieza con ella
 * (p. ej. `web:claude.ai`). Si el daemon no reporta salud para esa fuente, se asume ok.
 */
export function healthForSession(s: Pick<SessionView, 'source' | 'client'>, health: AdapterHealth[]): AdapterHealth | undefined {
  const exact = health.find((h) => h.name === `${s.source}:${s.client}` || h.name === s.client);
  if (exact) return exact;
  return health.find((h) => h.name === s.source || h.name.startsWith(`${s.source}:`) || h.name.startsWith(`${s.source}-`));
}

export function sessionHasNoData(s: SessionView, health: AdapterHealth[]): boolean {
  const h = healthForSession(s, health);
  return !!h && (h.status === 'error' || h.status === 'no-data');
}

export function meterText(s: SessionView, noData: boolean): string {
  if (noData || !s.contextWindow) return 'sin datos';
  return `${s.estimated ? '≈' : ''}${fmtPct(s.contextPct)}`;
}

// Toda buena práctica recomendada vigente pone el tray en rojo, sea cual sea su severidad.
const SEVERITY_TO_COLOR: Record<Suggestion['severity'], TrayColor> = { info: 'red', warn: 'red', critical: 'red' };
const COLOR_RANK: Record<TrayColor, number> = { gray: 0, green: 1, yellow: 2, red: 3 };

function worst(a: TrayColor, b: TrayColor): TrayColor {
  return COLOR_RANK[b] > COLOR_RANK[a] ? b : a;
}

/**
 * Color del tray = peor sesión activa. Gris: daemon no disponible o sin sesiones con datos.
 * Se combina el medidor de contexto con la severidad de la sugerencia vigente.
 */
export function trayColor(state: DesktopState, now: number): TrayColor {
  if (state.connection !== 'connected') return 'gray';
  let color: TrayColor = 'gray';
  // D-1: el aviso de cuenta (R10) también colorea el tray.
  for (const a of accountSuggestions(state, now)) color = worst(color, SEVERITY_TO_COLOR[a.severity]);
  for (const s of activeSessions(state, now)) {
    if (sessionHasNoData(s, state.health)) continue;
    let c: TrayColor = s.contextWindow ? meterLevel(s.contextPct) : 'green';
    const sug = visibleSuggestion(state, s.sessionId, now);
    if (sug) c = worst(c, SEVERITY_TO_COLOR[sug.severity]);
    color = worst(color, c);
  }
  return color;
}

/** CP-061: nombre legible de la sesión («contextpilot — título»); sin datos, el cliente. */
export function sessionLabel(s: SessionView): string {
  return sessionNameOf(s).name;
}

export function suggestionRow(s: Suggestion): SuggestionRow {
  return {
    id: s.id,
    ruleId: s.ruleId,
    severity: s.severity,
    title: s.title,
    detail: s.detail,
    savingText: s.estimatedSavingTokens ? `ahorro ≈${fmtTokens(s.estimatedSavingTokens)} tokens` : undefined,
    estimatedSavingTokens: s.estimatedSavingTokens,
    actions: s.actions.map((a, index) => ({ index, kind: a.kind, label: a.label, ...(a.kind === 'show-detail' ? { detail: a.payload ?? s.detail } : {}) })),
  };
}

/** D-1: sugerencias de cuenta vigentes (sessionId `account:<proveedor>`), no silenciosas. */
export function accountSuggestions(state: DesktopState, now: number): Suggestion[] {
  return Object.keys(state.suggestions)
    .filter((sid) => sid.startsWith('account:'))
    .map((sid) => visibleSuggestion(state, sid, now))
    .filter((s): s is Suggestion => !!s);
}

/** D-1: filas del banner de cuenta del overlay (una por proveedor). */
export function accountRows(state: DesktopState, now: number): AccountRow[] {
  return accountSuggestions(state, now).map((s) => ({ provider: s.sessionId.slice('account:'.length), suggestion: suggestionRow(s) }));
}

export function sessionRows(state: DesktopState, now: number): SessionRow[] {
  return activeSessions(state, now).map((s) => {
    const noData = sessionHasNoData(s, state.health);
    const sug = noData ? undefined : visibleSuggestion(state, s.sessionId, now);
    return {
      sessionId: s.sessionId,
      label: sessionLabel(s),
      shortId: sessionNameOf(s).shortId,
      provider: s.provider,
      source: s.source,
      model: s.model,
      meterText: meterText(s, noData),
      meterLevel: noData || !s.contextWindow ? 'none' : meterLevel(s.contextPct),
      contextPct: noData ? null : s.contextPct,
      cacheText: noData || s.cachePct === null ? 'caché —' : `caché ${fmtPct(s.cachePct)}`,
      noData,
      suggestion: sug ? suggestionRow(sug) : undefined,
      view: s,
    };
  });
}

const COLOR_TEXT: Record<TrayColor, string> = {
  green: 'todo en orden',
  yellow: 'atención',
  red: 'acción sugerida',
  gray: 'daemon no disponible',
};

/** Tooltip de Windows: máx. 127 caracteres. */
export function trayTooltip(state: DesktopState, now: number): string {
  const color = trayColor(state, now);
  if (state.connection !== 'connected') return 'ContextPilot · daemon no disponible';
  const rows = sessionRows(state, now);
  if (!rows.length) return 'ContextPilot · sin sesiones activas';
  const short = (t: string) => (t.length > 22 ? `${t.slice(0, 21)}…` : t);
  const parts = rows.slice(0, 3).map((r) => `${short(r.label)} ${r.meterText}`);
  const text = `ContextPilot · ${COLOR_TEXT[color]} · ${parts.join(' · ')}`;
  return text.length > 127 ? `${text.slice(0, 126)}…` : text;
}

export interface MenuItemModel {
  label: string;
  id?: string;
  enabled?: boolean;
  type?: 'normal' | 'separator';
}

/** Menú contextual del tray con las sesiones activas. */
export function trayMenuModel(state: DesktopState, now: number): MenuItemModel[] {
  const items: MenuItemModel[] = [];
  if (state.connection !== 'connected') {
    items.push({ label: 'Daemon no disponible', enabled: false });
  } else {
    const rows = sessionRows(state, now);
    if (!rows.length) items.push({ label: 'Sin sesiones activas', enabled: false });
    for (const r of rows.slice(0, 10)) {
      const flag = r.suggestion ? (r.suggestion.severity === 'critical' ? ' ⛔' : ' ⚠') : '';
      const name = r.label.length > 48 ? `${r.label.slice(0, 47)}…` : r.label;
      items.push({ label: `${name} · ${r.shortId} — ${r.meterText}${flag}`, id: `session:${r.sessionId}` });
    }
  }
  items.push({ label: '', type: 'separator' });
  items.push({ label: 'Abrir panel', id: 'overlay' });
  items.push({ label: 'Dashboard', id: 'dashboard' });
  items.push({ label: 'Claude Desktop: probar captura CDP', id: 'claude-desktop' });
  items.push({ label: '', type: 'separator' });
  items.push({ label: 'Salir', id: 'quit' });
  return items;
}
