// Badge por pestaña (CP-049.1/.3, SPEC §9): verde < 50 %, amarillo 50–75 %, rojo > 75 %.
// El texto es el % (el «≈» queda implícito por espacio; el tooltip lo aclara).
// Sin datos (daemon caído, adaptador en error o sin sesión con turnos) → «?» gris.

export const BADGE_COLORS = {
  green: '#16a34a',
  yellow: '#ca8a04',
  red: '#dc2626',
  gray: '#6b7280',
} as const;

export type BadgeLevel = keyof typeof BADGE_COLORS;

export interface BadgeSpec {
  text: string;
  color: string;
  level: BadgeLevel;
  title: string;
}

/** Nivel por porcentaje (0–100). */
export function levelFor(pct: number): Exclude<BadgeLevel, 'gray'> {
  if (pct < 50) return 'green';
  if (pct <= 75) return 'yellow';
  return 'red';
}

export function badgeFor(pct: number | null | undefined, status: 'ok' | 'no-data' | 'error' = 'ok'): BadgeSpec {
  if (status !== 'ok' || pct === null || pct === undefined || !Number.isFinite(pct)) {
    return { text: '?', color: BADGE_COLORS.gray, level: 'gray', title: 'ContextPilot: sin datos' };
  }
  const level = levelFor(pct);
  const shown = Math.min(999, Math.floor(pct));
  return {
    text: `${shown}%`,
    color: BADGE_COLORS[level],
    level,
    title: `ContextPilot: ≈${shown} % de la ventana de contexto (estimado)`,
  };
}

/** Sin sesión en la pestaña (no es un chat o es un chat nuevo sin turnos): badge vacío. */
export const EMPTY_BADGE: BadgeSpec = { text: '', color: BADGE_COLORS.gray, level: 'gray', title: 'ContextPilot' };
