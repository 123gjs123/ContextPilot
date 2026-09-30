import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT, rmrf, startTestDaemon, tempDir, waitFor } from './helpers.js';

// CP-032 (instalador + reenvío), CP-045 (statusline), CP-029 (clientes sin daemon).
// El instalador corre SIEMPRE contra un HOME temporal: nunca contra el ~/.claude real.

const INSTALL = join(ROOT, 'scripts', 'install-hooks.mjs');
const HOOK = join(ROOT, 'scripts', 'hook.mjs');
const STATUS = join(ROOT, 'scripts', 'statusline.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

function fakeHome() {
  const home = tempDir('cp-home-');
  dirs.push(home);
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  return { home, env, settings: join(home, '.claude', 'settings.json') };
}

function install(env: NodeJS.ProcessEnv, ...args: string[]) {
  const r = spawnSync(process.execPath, [INSTALL, ...args], { env, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe('install-hooks.mjs (HOME temporal)', () => {
  it('instala 4 hooks preservando los existentes, con backup; idempotente; --uninstall quita sólo los propios', () => {
    const { env, settings } = fakeHome();
    mkdirSync(join(settings, '..'), { recursive: true });
    const original = {
      theme: 'dark',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ajeno' }] }] },
      statusLine: { type: 'command', command: 'mi-statusline' },
    };
    writeFileSync(settings, JSON.stringify(original, null, 2));

    install(env);
    const s1 = JSON.parse(readFileSync(settings, 'utf8'));
    for (const h of ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop']) {
      const cmds = s1.hooks[h].flatMap((g: any) => g.hooks.map((x: any) => x.command));
      expect(cmds.some((c: string) => c.includes('hook.mjs') && c.endsWith(h))).toBe(true);
    }
    expect(s1.hooks.Stop.flatMap((g: any) => g.hooks.map((x: any) => x.command))).toContain('echo ajeno');
    expect(s1.theme).toBe('dark');
    expect(JSON.parse(readFileSync(`${settings}.cp-bak`, 'utf8'))).toEqual(original);

    const before = readFileSync(settings, 'utf8');
    expect(install(env)).toContain('Sin cambios');
    expect(readFileSync(settings, 'utf8')).toBe(before);

    // --statusline no pisa una ajena sin --force
    expect(install(env, '--statusline')).toContain('no se modifica');
    expect(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command).toBe('mi-statusline');
    install(env, '--statusline', '--force');
    expect(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command).toContain('statusline.mjs');

    install(env, '--uninstall');
    const s2 = JSON.parse(readFileSync(settings, 'utf8'));
    expect(s2.hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'echo ajeno' }] }] });
    expect(s2.statusLine).toBeUndefined();
    expect(s2.theme).toBe('dark');
  });

  it('sin settings.json previo: lo crea (sin backup)', () => {
    const { env, settings } = fakeHome();
    install(env, '--statusline');
    const s = JSON.parse(readFileSync(settings, 'utf8'));
    expect(Object.keys(s.hooks)).toHaveLength(4);
    expect(s.statusLine.command).toContain('statusline.mjs');
    expect(existsSync(`${settings}.cp-bak`)).toBe(false);
  });
});

function runScript(script: string, args: string[], input: string, env: NodeJS.ProcessEnv) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [script, ...args], { input, env, encoding: 'utf8', timeout: 10_000 });
  return { ...r, ms: performance.now() - t0 };
}

/** Versión asíncrona: el daemon de test corre en este mismo proceso y spawnSync lo bloquearía. */
function runAsync(script: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { env });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => resolve({ status, stdout, stderr }));
    c.stdin.end(input);
  });
}

describe('hook.mjs y statusline.mjs', () => {
  it('daemon caído: hook sale 0 sin salida; statusline imprime «sin datos»', () => {
    const home = tempDir();
    dirs.push(home);
    const env = { ...process.env, CONTEXTPILOT_HOME: home, CONTEXTPILOT_PORT: '1' };
    const h = runScript(HOOK, ['UserPromptSubmit'], JSON.stringify({ session_id: 'x', prompt: 'hola' }), env);
    expect(h.status).toBe(0);
    expect(h.stdout).toBe('');
    expect(h.stderr).toBe('');
    console.log(`hook.mjs con daemon caído: ${h.ms.toFixed(0)} ms (incluye arranque de node)`);
    expect(h.ms).toBeLessThan(1500);
    const s = runScript(STATUS, [], JSON.stringify({ session_id: 'x' }), env);
    expect(s.status).toBe(0);
    expect(s.stdout.trim()).toBe('ContextPilot: sin datos');
    // stdin basura tampoco rompe
    expect(runScript(HOOK, ['Stop'], 'no json', env).status).toBe(0);
  });

  it('daemon arriba: el hook registra sesión ↔ transcript y la statusline muestra la línea', async () => {
    const t = await startTestDaemon();
    const env = { ...process.env, CONTEXTPILOT_HOME: t.home, CONTEXTPILOT_PORT: String(t.d.port) };
    const transcript = join(t.dirs.claude, 'C--repo', 'hooked.jsonl');
    const h = await runAsync(HOOK, ['SessionStart'], JSON.stringify({ session_id: 'hooked', transcript_path: transcript, hook_event_name: 'SessionStart' }), env);
    expect(h.status).toBe(0);
    expect(h.stdout).toBe('');
    await waitFor(() => t.d.storage.getTranscript('hooked'));
    expect(t.d.storage.getTranscript('hooked')?.path).toBe(transcript);
    expect(t.d.health.get('hooks')?.status).toBe('ok');

    // hook desconocido → 202, contado en health
    const r = await t.api('/ingest/hooks/Weird', { method: 'POST', json: {} });
    expect(r.status).toBe(202);
    expect(t.d.health.get('hooks')?.detail).toContain('desconocidos: 1');

    await t.api('/ingest/events', {
      method: 'POST',
      json: [
        {
          id: 'SL1', source: 'claude-code', provider: 'anthropic', client: 'cli', sessionId: 'hooked', turn: 1, ts: new Date().toISOString(),
          model: 'claude-sonnet-4-5', tokens: { input: 100, output: 50, cacheRead: 90_000, cacheWrite: 0, estimated: false },
          contextSize: 90_150, contextWindow: 200_000, idleSincePrevMs: 0, promptHash: '',
        },
      ],
    });
    const s = await runAsync(STATUS, [], JSON.stringify({ session_id: 'hooked', model: { id: 'x' } }), env);
    expect(s.stdout.trim()).toBe('ctx 45% · cache 100%');
    await t.close();
  });
});
