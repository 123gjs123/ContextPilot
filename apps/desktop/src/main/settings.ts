import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Rutas y ajustes locales de la app desktop (DECISIONS «Rutas de datos»; docs/API.md).

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CONTEXTPILOT_HOME) return env.CONTEXTPILOT_HOME;
  return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ContextPilot');
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CONTEXTPILOT_PORT);
  return env.CONTEXTPILOT_PORT && Number.isInteger(n) && n > 0 && n < 65536 ? n : 47800;
}

export function readToken(home: string): string | undefined {
  try {
    const t = readFileSync(join(home, 'token'), 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export interface DesktopSettings {
  /** Lanzar el daemon si no responde (apagado por defecto). */
  spawnDaemon: boolean;
  /** Comando para lanzar el daemon; por defecto `node --import tsx apps/daemon/src/main.ts` desde la raíz. */
  daemonCommand?: string[];
  /** Puerto CDP para Claude Desktop. */
  cdpPort: number;
  /** Engancharse al puerto CDP al iniciar (si alguien ya abrió Claude Desktop con el puerto). */
  cdpAttachOnStart: boolean;
  /** Notificaciones de Windows para cada buena práctica recomendada. */
  notifications: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = { spawnDaemon: false, cdpPort: 9339, cdpAttachOnStart: false, notifications: true };

/** `desktop.json` en la carpeta de datos + overrides por env. */
export function loadSettings(home: string, env: NodeJS.ProcessEnv = process.env): DesktopSettings {
  let file: Partial<DesktopSettings> = {};
  const p = join(home, 'desktop.json');
  if (existsSync(p)) {
    try {
      file = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      file = {};
    }
  }
  const s: DesktopSettings = { ...DEFAULT_SETTINGS, ...file };
  if (env.CONTEXTPILOT_SPAWN_DAEMON !== undefined) s.spawnDaemon = env.CONTEXTPILOT_SPAWN_DAEMON === '1';
  if (env.CONTEXTPILOT_CDP_ATTACH !== undefined) s.cdpAttachOnStart = env.CONTEXTPILOT_CDP_ATTACH === '1';
  if (env.CONTEXTPILOT_CDP_PORT) s.cdpPort = Number(env.CONTEXTPILOT_CDP_PORT) || s.cdpPort;
  return s;
}

/** Rutas del renderer al daemon permitidas vía IPC (el renderer nunca ve el token). */
const ALLOWED: { method: string; re: RegExp }[] = [
  { method: 'GET', re: /^\/sessions(\?.*)?$/ },
  { method: 'GET', re: /^\/sessions\/[^/?#]+$/ },
  { method: 'GET', re: /^\/suggestions(\?.*)?$/ },
  { method: 'GET', re: /^\/health$/ },
  { method: 'GET', re: /^\/stats(\?.*)?$/ },
  { method: 'GET', re: /^\/config$/ },
  { method: 'GET', re: /^\/config\/export$/ },
  { method: 'GET', re: /^\/team\/export(\?.*)?$/ },
  { method: 'PUT', re: /^\/config$/ },
  { method: 'POST', re: /^\/config\/import(\?dryRun=(true|false))?$/ },
  { method: 'POST', re: /^\/handoff$/ },
  { method: 'POST', re: /^\/mcp\/(disable|enable)$/ },
  { method: 'POST', re: /^\/suggestions\/[^/?#]+\/feedback$/ },
];

export function isAllowedApi(method: string, path: string): boolean {
  if (path.includes('..')) return false;
  return ALLOWED.some((a) => a.method === method && a.re.test(path));
}
