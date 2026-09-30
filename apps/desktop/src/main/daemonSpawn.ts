import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Lanza el daemon si no responde (opcional; apagado por defecto: `spawnDaemon` en desktop.json o
// CONTEXTPILOT_SPAWN_DAEMON=1). El daemon sigue vivo si el desktop se cierra (RNF-08).

export function repoRootFrom(outDir: string): string {
  // apps/desktop/out → raíz del repo
  return resolve(outDir, '..', '..', '..');
}

export function defaultDaemonCommand(repoRoot: string): { cmd: string; args: string[]; cwd: string } | undefined {
  const entry = join(repoRoot, 'apps', 'daemon', 'src', 'main.ts');
  if (!existsSync(entry)) return undefined;
  return { cmd: 'node', args: ['--import', 'tsx', entry], cwd: repoRoot };
}

let child: ChildProcess | undefined;

export function spawnDaemon(repoRoot: string, home: string, custom?: string[]): { ok: boolean; message: string } {
  if (child && child.exitCode === null) return { ok: true, message: 'daemon ya lanzado' };
  const def = custom?.length ? { cmd: custom[0]!, args: custom.slice(1), cwd: repoRoot } : defaultDaemonCommand(repoRoot);
  if (!def) return { ok: false, message: 'apps/daemon/src/main.ts no existe todavía' };
  mkdirSync(join(home, 'logs'), { recursive: true });
  const log = openSync(join(home, 'logs', 'daemon-desktop-spawn.log'), 'a');
  const env = { ...process.env };
  // --use-system-ca lo rechaza Electron, pero el daemon es Node: no se toca NODE_OPTIONS acá.
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(def.cmd, def.args, { cwd: def.cwd, env, detached: true, stdio: ['ignore', log, log], windowsHide: true, shell: false });
  child.unref();
  return { ok: true, message: `daemon lanzado (pid ${child.pid})` };
}
