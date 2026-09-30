import { redact } from './redact.js';
import type { Source } from './types.js';

// CP-061: nombres legibles de sesión. Puro: lo usan daemon (SessionView), desktop y extensión.
// DECISIONS «nombres de sesión»: `project` = nombre base de la carpeta de trabajo (se persiste en
// el estado de la sesión); `title` = título de la conversación (contenido del usuario: sólo memoria).

/** Largo máximo de un título mostrado (se corta con «…»). */
export const TITLE_MAX_CHARS = 80;
const PROJECT_MAX_CHARS = 60;

/** Nombre base de una ruta de trabajo (`C:\Users\x\contextpilot` → `contextpilot`), sin separadores. */
export function projectFromCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string') return undefined;
  const parts = cwd.trim().split(/[\\/]+/).filter(Boolean);
  const base = parts.at(-1);
  if (!base || /^[A-Za-z]:$/.test(base)) return undefined;
  return base.length > PROJECT_MAX_CHARS ? `${base.slice(0, PROJECT_MAX_CHARS - 1)}…` : base;
}

/** Título limpio: una línea, redactado (secretos), ≤ TITLE_MAX_CHARS. undefined si queda vacío. */
export function cleanTitle(t: unknown): string | undefined {
  if (typeof t !== 'string') return undefined;
  const one = redact(t).replace(/\s+/g, ' ').trim();
  if (!one) return undefined;
  return one.length > TITLE_MAX_CHARS ? `${one.slice(0, TITLE_MAX_CHARS - 1)}…` : one;
}

/** Id corto para mostrar como texto secundario (8 caracteres del último segmento). */
export function shortSessionId(sessionId: string): string {
  const last = sessionId.includes(':') ? sessionId.split(':').pop()! : sessionId;
  return last.slice(0, 8);
}

export interface NameParts {
  sessionId: string;
  source: Source | string;
  client?: string;
  project?: string;
  title?: string;
}

/**
 * Nombre principal: «proyecto — título», sólo proyecto, sólo título o, sin ninguno, el cliente
 * (`claude-code`, `claude.ai`…). En web/desktop el «proyecto» es el sitio (`client`).
 */
export function sessionDisplayName(p: NameParts): string {
  const chat = p.source === 'web' || p.source === 'desktop';
  const project = p.project || (chat ? p.client : undefined);
  const title = p.title;
  if (project && title) return `${project} — ${title}`;
  if (project) return project;
  if (title) return title;
  return p.client || String(p.source);
}

/** Nombre principal + id corto (texto secundario) de una vista de sesión. */
export function sessionNameOf(v: NameParts & { displayName?: string }): { name: string; shortId: string } {
  return { name: v.displayName || sessionDisplayName(v), shortId: shortSessionId(v.sessionId) };
}
