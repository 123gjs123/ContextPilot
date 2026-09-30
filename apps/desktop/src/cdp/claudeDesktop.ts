import { spawn, execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnEvent } from '@contextpilot/core';
import { ClaudeDesktopCapture } from './capture.js';

// CP-043: adaptador Claude Desktop vía CDP. Sólo lectura: Network.enable + Network.getResponseBody.
// Hallazgo del spike (docs/SPIKE-desktop.md): Claude Desktop 2.16120 rechaza arrancar con
// --remote-debugging-port salvo que CLAUDE_CDP_AUTH traiga un token firmado por Anthropic
// (Ed25519). Por eso el launcher detecta el rechazo y el adaptador queda en 'error' con detalle;
// la captura queda lista por si una versión futura (o una política de IT) habilita el puerto.

export const REFUSAL_RE = /refusing to start/i;
export const DEFAULT_CDP_PORT = 9229 + 110; // 9339: puerto libre, distinto del inspector de Node

export type AdapterStatus = 'ok' | 'no-data' | 'error' | 'disabled';

export interface AdapterReport {
  status: AdapterStatus;
  detail: string;
  lastEventAt?: string;
}

/** Busca claude.exe: MSIX (WindowsApps vía Get-AppxPackage) o instalación Squirrel en %LOCALAPPDATA%. */
export async function findClaudeExe(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.CONTEXTPILOT_CLAUDE_EXE && existsSync(env.CONTEXTPILOT_CLAUDE_EXE)) return env.CONTEXTPILOT_CLAUDE_EXE;
  const squirrel = join(env.LOCALAPPDATA ?? '', 'AnthropicClaude');
  if (existsSync(squirrel)) {
    const app = readdirSync(squirrel).filter((d) => d.startsWith('app-')).sort().pop();
    if (app && existsSync(join(squirrel, app, 'claude.exe'))) return join(squirrel, app, 'claude.exe');
  }
  const loc = await new Promise<string>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-AppxPackage -Name Claude | Select-Object -First 1).InstallLocation'],
      { timeout: 10_000, windowsHide: true },
      (_err, stdout) => resolve(String(stdout ?? '').trim()),
    );
  });
  if (loc && existsSync(join(loc, 'app', 'claude.exe'))) return join(loc, 'app', 'claude.exe');
  return undefined;
}

export interface LaunchResult {
  ok: boolean;
  reason?: 'not-installed' | 'refused' | 'exited' | 'already-running';
  message: string;
  pid?: number;
}

/**
 * Inicia Claude Desktop con el puerto de depuración a pedido del usuario. Si la app lo rechaza
 * (sale con código ≠ 0 y el mensaje «refusing to start») se informa sin reintentar.
 */
export async function launchClaudeDesktop(port = DEFAULT_CDP_PORT, waitMs = 6000): Promise<LaunchResult> {
  const exe = await findClaudeExe();
  if (!exe) return { ok: false, reason: 'not-installed', message: 'Claude Desktop no está instalado' };
  return new Promise((resolve) => {
    const child = spawn(exe, [`--remote-debugging-port=${port}`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: false });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    const done = (r: LaunchResult) => {
      clearTimeout(timer);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(r);
    };
    child.on('error', (e) => done({ ok: false, reason: 'exited', message: `No se pudo iniciar: ${e.message}` }));
    child.on('exit', (code) => {
      if (REFUSAL_RE.test(out)) {
        done({
          ok: false,
          reason: 'refused',
          message: 'Claude Desktop rechaza --remote-debugging-port (exige un token CLAUDE_CDP_AUTH firmado por Anthropic). Ver docs/SPIKE-desktop.md.',
        });
      } else {
        done({
          ok: false,
          reason: code === 0 ? 'already-running' : 'exited',
          message: code === 0 ? 'Claude Desktop ya estaba abierto: cerralo del todo y reintentá.' : `Claude Desktop salió con código ${code}`,
        });
      }
    });
    const timer = setTimeout(() => {
      child.unref();
      done({ ok: true, message: `Claude Desktop iniciado con CDP en 127.0.0.1:${port}`, pid: child.pid });
    }, waitMs);
  });
}

interface CdpClient {
  send(method: string, params?: object): Promise<any>;
  on(event: 'event', cb: (msg: { method: string; params: any }) => void): void;
  on(event: 'disconnect', cb: () => void): void;
  close(): Promise<void>;
}

/** Métodos CDP permitidos (CP-043.3): nada que modifique la página. */
export const ALLOWED_CDP_METHODS = new Set(['Network.enable', 'Network.getResponseBody']);

export function assertReadOnly(method: string): void {
  if (!ALLOWED_CDP_METHODS.has(method)) throw new Error(`Método CDP no permitido (sólo lectura): ${method}`);
}

export interface ClaudeDesktopAdapterOptions {
  port?: number;
  retryMs?: number;
  emit(events: TurnEvent[]): Promise<void>;
  onReport?(r: AdapterReport): void;
}

/**
 * Se conecta al puerto CDP si está disponible; si no, health 'no-data' y reintenta cada 60 s
 * (CP-043.2). Se engancha a cada target 'page' de claude.ai.
 */
export class ClaudeDesktopAdapter {
  private timer?: NodeJS.Timeout;
  private clients = new Map<string, CdpClient>();
  private stopped = false;
  report: AdapterReport = { status: 'no-data', detail: 'Puerto CDP no disponible' };

  constructor(private readonly opts: ClaudeDesktopAdapterOptions) {}

  private setReport(r: AdapterReport): void {
    this.report = r;
    this.opts.onReport?.(r);
  }

  /** Marca el adaptador como bloqueado por la app (rechazo del switch) sin reintentar en loop. */
  markRefused(message: string): void {
    this.setReport({ status: 'error', detail: message });
  }

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.clients.values()) void c.close().catch(() => {});
    this.clients.clear();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.opts.retryMs ?? 60_000);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const port = this.opts.port ?? DEFAULT_CDP_PORT;
    try {
      const CDP = (await import('chrome-remote-interface')).default as any;
      const targets: { id: string; type: string; url: string }[] = await CDP.List({ host: '127.0.0.1', port });
      const pages = targets.filter((t) => t.type === 'page' && /claude\.ai/.test(t.url));
      if (!pages.length && !this.clients.size) {
        if (this.report.status !== 'error') this.setReport({ status: 'no-data', detail: 'CDP activo pero sin páginas de claude.ai' });
      }
      for (const t of pages) {
        if (this.clients.has(t.id)) continue;
        const client: CdpClient = await CDP({ host: '127.0.0.1', port, target: t.id });
        const send = (m: string, p?: object) => {
          assertReadOnly(m);
          return client.send(m, p);
        };
        const cap = new ClaudeDesktopCapture({
          getResponseBody: (requestId) => send('Network.getResponseBody', { requestId }),
          emit: async (evs) => {
            this.setReport({ status: 'ok', detail: 'Capturando', lastEventAt: evs.at(-1)?.ts });
            await this.opts.emit(evs);
          },
        });
        client.on('event', (msg) => cap.onEvent(msg.method, msg.params));
        client.on('disconnect', () => this.clients.delete(t.id));
        await send('Network.enable', { maxPostDataSize: 1_000_000 });
        this.clients.set(t.id, client);
        if (this.report.status !== 'ok') this.setReport({ status: 'ok', detail: `Conectado a ${this.clients.size} página(s)` });
      }
    } catch {
      if (!this.clients.size && this.report.status !== 'error') this.setReport({ status: 'no-data', detail: 'Puerto CDP no disponible' });
    }
    this.schedule();
  }

}
