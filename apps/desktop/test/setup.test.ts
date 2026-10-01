import { describe, expect, it } from 'vitest';
import { missingRequired, setupItems, type SetupFacts } from '../src/shared/setup.js';

const all: SetupFacts = {
  claudeBin: 'C:\npm\claude.cmd',
  loggedIn: true,
  daemonConnected: true,
  hooksInstalled: true,
  playwrightConfigured: true,
  playwrightStatus: 'connected',
  desktopHealth: { status: 'ok' },
  webHealth: { status: 'ok' },
  repoRoot: 'C:\repo',
};
const byId = (f: SetupFacts) => Object.fromEntries(setupItems(f).map((i) => [i.id, i]));

describe('puesta en marcha', () => {
  it('todo listo: sin obligatorios pendientes ni comandos', () => {
    const items = setupItems(all);
    expect(items.every((i) => i.status === 'ok')).toBe(true);
    expect(missingRequired(items)).toEqual([]);
  });

  it('desde cero: CLI, login y daemon obligatorios con su comando', () => {
    const f: SetupFacts = { claudeBin: null, daemonConnected: false, hooksInstalled: false, playwrightConfigured: false, repoRoot: 'C:\repo' };
    const m = missingRequired(setupItems(f)).map((i) => i.id);
    expect(m).toEqual(['claude', 'login', 'daemon']);
    const i = byId(f);
    expect(i.claude!.command).toContain('@anthropic-ai/claude-code');
    expect(i.login!.command).toBe('claude auth login');
    expect(i.daemon!.command).toContain('scripts/start.ps1');
    expect(i.daemon!.command).toContain('C:\repo');
    expect(i.hooks).toMatchObject({ status: 'warn', required: false, command: expect.stringContaining('install-hooks.mjs') });
    expect(i.playwright!.command).toContain('claude mcp add --scope user playwright');
    expect(i.desktop!.status).toBe('optional');
    expect(i.extension!.status).toBe('optional');
  });

  it('login desconocido = advertencia; Playwright configurado que no conecta = diagnóstico', () => {
    const i = byId({ ...all, loggedIn: undefined, playwrightStatus: 'failed' });
    expect(i.login!.status).toBe('warn');
    expect(i.playwright).toMatchObject({ status: 'warn', command: 'claude mcp get playwright' });
    expect(byId({ ...all, playwrightStatus: undefined }).playwright!.status).toBe('ok');
    expect(byId({ ...all, desktopHealth: { status: 'error', detail: 'formato 3.0' } }).desktop).toMatchObject({ status: 'warn', detail: 'formato 3.0' });
  });
});
