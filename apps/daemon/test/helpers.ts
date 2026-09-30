import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { TurnEvent } from '@contextpilot/core';
import { startDaemon, type Daemon, type DaemonOptions } from '../src/daemon.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CORE_FIXTURES = join(ROOT, 'packages', 'core', 'test', 'fixtures');

export function coreFixture(rel: string): string {
  return readFileSync(join(CORE_FIXTURES, rel), 'utf8');
}

export function tempDir(prefix = 'cp-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function rmrf(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Windows puede retener archivos unos ms; no es un fallo del test
  }
}

export interface TestDaemon {
  d: Daemon;
  base: string;
  token: string;
  home: string;
  dirs: { claude: string; codex: string; gemini: string };
  api(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

/** Daemon aislado: home temporal, puerto libre, directorios de CLIs temporales, sin claude real. */
export async function startTestDaemon(over: Partial<DaemonOptions> & { home?: string; dirs?: Partial<TestDaemon['dirs']> } = {}): Promise<TestDaemon> {
  const home = over.home ?? tempDir();
  const scratch = tempDir('cp-cli-');
  const dirs = {
    claude: over.dirs?.claude ?? join(scratch, 'claude-projects'),
    codex: over.dirs?.codex ?? join(scratch, 'codex-sessions'),
    gemini: over.dirs?.gemini ?? join(scratch, 'gemini'),
  };
  if (!over.home) {
    // outfile de Gemini en el temporal (config persistida antes de arrancar)
    writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { geminiOutfile: join(dirs.gemini, 'telemetry.log') } }));
  }
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  // Nunca leer el plan-usage real de Claude Desktop en tests (cambiaría R10).
  env.CONTEXTPILOT_PLAN_USAGE_FILE ??= join(scratch, 'plan-usage-history.json');
  const d = await startDaemon({
    home,
    port: 0,
    quiet: true,
    env,
    claudeProjectsDir: dirs.claude,
    codexSessionsDir: dirs.codex,
    claudeBin: () => null,
    rescanMs: 60_000,
    rootRetryMs: 200,
    ...over,
  });
  const base = `http://127.0.0.1:${d.port}`;
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    return fetch(base + path, {
      ...rest,
      headers: { 'x-cp-token': d.token, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  };
  return {
    d,
    base,
    token: d.token,
    home,
    dirs,
    api,
    async close() {
      await d.close();
      if (!over.home) rmrf(home);
      rmrf(scratch);
    },
  };
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

/** Cliente WS que junta mensajes y permite esperar uno por predicado. */
export async function wsClient(base: string, token: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/stream?token=${token}`);
  const msgs: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    msgs.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return {
    ws,
    msgs,
    next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout esperando mensaje WS')), timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

/** Evento de respuesta válido (contrato completo). */
export function ev(over: Partial<TurnEvent> = {}): TurnEvent {
  return {
    id: 'E' + Math.random().toString(36).slice(2),
    source: 'claude-code',
    provider: 'anthropic',
    client: 'cli',
    sessionId: 'S1',
    turn: 1,
    ts: new Date().toISOString(),
    model: 'claude-sonnet-4-5',
    tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, estimated: false },
    contextSize: 1000,
    contextWindow: 200_000,
    idleSincePrevMs: 0,
    promptHash: '',
    phase: 'response',
    ...over,
  };
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 3000, stepMs = 20): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('timeout en waitFor');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** D-17: hijos vivos; se matan si el worker de vitest termina (test que falló antes de stop()). */
const children = new Set<import('node:child_process').ChildProcess>();
process.once('exit', () => {
  for (const c of children) c.kill();
});

/**
 * Daemon real en un proceso aparte (node --import tsx main.ts): para medir latencias sin que el
 * upstream simulado y el cliente compitan por el mismo event loop.
 */
export async function spawnDaemon(env: Record<string, string>): Promise<{ base: string; home: string; stop(): Promise<void> }> {
  const { spawn } = await import('node:child_process');
  const home = tempDir('cp-proc-');
  const port = 47_000 + Math.floor(Math.random() * 700);
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'apps', 'daemon', 'src', 'main.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONTEXTPILOT_HOME: home,
      CONTEXTPILOT_PORT: String(port),
      CONTEXTPILOT_CLAUDE_PROJECTS: join(home, 'no-projects'),
      CONTEXTPILOT_CODEX_SESSIONS: join(home, 'no-codex'),
      CONTEXTPILOT_PLAN_USAGE_FILE: join(home, 'no-plan.json'),
      ...env,
    },
    stdio: 'ignore',
  });
  children.add(child);
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  void exited.then(() => children.delete(child));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/health`)).ok;
    } catch {
      return false;
    }
  }, 15_000, 100);
  return {
    base,
    home,
    async stop() {
      // D-17: idempotente y sin colgarse si el hijo ya salió.
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      rmrf(home);
    },
  };
}
