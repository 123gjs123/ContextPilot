import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Rutas de datos (DECISIONS «Rutas de datos»): %LOCALAPPDATA%\ContextPilot, override CONTEXTPILOT_HOME.

export interface DaemonPaths {
  home: string;
  token: string;
  config: string;
  db: string;
  ca: string;
  logs: string;
}

export const DEFAULT_PORT = 47800;

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CONTEXTPILOT_HOME) return env.CONTEXTPILOT_HOME;
  const base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(base, 'ContextPilot');
}

export function resolvePaths(home = resolveHome()): DaemonPaths {
  return {
    home,
    token: join(home, 'token'),
    config: join(home, 'config.json'),
    db: join(home, 'cp.db'),
    ca: join(home, 'ca.pem'),
    logs: join(home, 'logs'),
  };
}

export function ensureDirs(p: DaemonPaths): void {
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.logs, { recursive: true });
}

/** CP-022.2: token aleatorio de 32 bytes (hex) generado al primer arranque y reutilizado. */
export function loadOrCreateToken(p: DaemonPaths): string {
  if (existsSync(p.token)) {
    const t = readFileSync(p.token, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  }
  const t = randomBytes(32).toString('hex');
  writeAtomic(p.token, t);
  return t;
}

/** Escritura atómica: archivo temporal + rename (un corte a mitad no deja el destino corrupto). */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CONTEXTPILOT_PORT);
  return Number.isInteger(n) && n >= 0 && n < 65536 && env.CONTEXTPILOT_PORT !== '' && env.CONTEXTPILOT_PORT !== undefined
    ? n
    : DEFAULT_PORT;
}

/** Codifica un cwd como lo hace Claude Code para la carpeta de proyecto (no alfanumérico → '-'). */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
