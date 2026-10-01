import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findClaude } from './chatHost.js';

// Hechos para el panel «Puesta en marcha». De ~/.claude.json sólo se leen los NOMBRES de los
// servidores MCP y de settings.json sólo los comandos de hooks: nunca tokens ni credenciales.

const LOGIN_TTL_MS = 60_000;
let loginCache: { at: number; value: boolean | undefined } | undefined;

function claudeHome(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(env.USERPROFILE ?? homedir(), '.claude');
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function hooksInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const s = readJson(join(claudeHome(env), 'settings.json'));
  const groups = Object.values<any>(s?.hooks ?? {}).flat();
  return groups.some((g: any) => (g?.hooks ?? []).some((h: any) => typeof h?.command === 'string' && h.command.includes('hook.mjs')));
}

export function mcpConfigured(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const j = readJson(join(env.USERPROFILE ?? homedir(), '.claude.json'));
  if (j?.mcpServers && Object.prototype.hasOwnProperty.call(j.mcpServers, name)) return true;
  return Object.values<any>(j?.projects ?? {}).some((p) => p?.mcpServers && Object.prototype.hasOwnProperty.call(p.mcpServers, name));
}

/** `claude auth status --json` → loggedIn (cacheado 1 min). undefined si no se pudo consultar. */
export function loggedIn(bin: string | null, force = false): Promise<boolean | undefined> {
  if (!bin) return Promise.resolve(undefined);
  if (!force && loginCache && Date.now() - loginCache.at < LOGIN_TTL_MS) return Promise.resolve(loginCache.value);
  return new Promise((resolve) => {
    const shell = /\.(cmd|bat)$/i.test(bin);
    let out = '';
    const p = spawn(shell ? `"${bin}"` : bin, ['auth', 'status', '--json'], { shell, windowsHide: true });
    const done = (v: boolean | undefined) => {
      loginCache = { at: Date.now(), value: v };
      resolve(v);
    };
    const t = setTimeout(() => {
      p.kill();
      done(undefined);
    }, 15_000);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => {
      clearTimeout(t);
      done(undefined);
    });
    p.on('exit', () => {
      clearTimeout(t);
      try {
        done(JSON.parse(out).loggedIn === true);
      } catch {
        done(undefined);
      }
    });
  });
}

export { findClaude };
