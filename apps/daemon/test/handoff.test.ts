import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractiveSummary, findClaudeBin, readTranscript } from '../src/handoff.js';
import { coreFixture, ROOT, rmrf, startTestDaemon, tempDir } from './helpers.js';

// CP-052 (servicio de traspaso) y CP-053 (script CLI con portapapeles).

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

const SECRET = 'sk-ant-api03-SECRETOSECRETOSECRETO0123456789';
const iso = (m: number) => new Date(Date.UTC(2026, 8, 30, 10, m)).toISOString();

function transcript(sid: string): string {
  const L = (o: object) => JSON.stringify({ sessionId: sid, ...o });
  return [
    L({ type: 'user', timestamp: iso(0), message: { role: 'user', content: `Migrá el parser de sesiones a TypeScript estricto. Mi clave es ${SECRET}` } }),
    L({
      type: 'assistant',
      timestamp: iso(1),
      message: {
        id: 'm1', model: 'claude-sonnet-4-5', role: 'assistant',
        content: [
          { type: 'text', text: 'Vamos a usar un parser incremental por offset de bytes.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/repo/src/parser.ts' } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
    L({ type: 'user', timestamp: iso(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contenido del archivo' }] } }),
    L({
      type: 'assistant',
      timestamp: iso(3),
      message: {
        id: 'm2', model: 'claude-sonnet-4-5', role: 'assistant',
        content: [
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'C:/repo/src/parser.ts', old_string: 'a', new_string: 'b' } },
          { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test -- parser' } },
          {
            type: 'tool_use', id: 't4', name: 'TodoWrite',
            input: { todos: [{ content: 'Agregar tests de líneas partidas', status: 'pending' }, { content: 'Migrar tipos', status: 'completed' }] },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
    L({ type: 'user', timestamp: iso(4), message: { role: 'user', content: 'Ahora sumá soporte para subagentes también' } }),
    L({
      type: 'assistant',
      timestamp: iso(5),
      message: { id: 'm3', model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'Listo. Falta: validar con transcripts reales.' }], usage: { input_tokens: 1, output_tokens: 1 } },
    }),
  ].join('\n');
}

describe('resumen extractivo', () => {
  it('secciones fijas, determinista, redactado, archivos y pendientes', () => {
    const conv = readTranscript(transcript('S'));
    const a = extractiveSummary(conv);
    const b = extractiveSummary(readTranscript(transcript('S')));
    expect(a).toBe(b);
    for (const h of ['## Objetivo', '## Estado', '## Decisiones', '## Archivos', '## Próximos pasos']) expect(a).toContain(h);
    expect(a).not.toContain(SECRET);
    expect(a).toContain('[REDACTED:anthropic-key]');
    expect(a).toContain('C:/repo/src/parser.ts (editado)');
    expect(a).toContain('Agregar tests de líneas partidas');
    expect(a).not.toContain('Migrar tipos');
    expect(a).toContain('subagentes');
    expect(a).toMatch(/Vamos a usar un parser incremental/);
  });

  it('< 2 s sobre el transcript de fixture más grande', () => {
    const big = Array.from({ length: 40 }, () => coreFixture('claude-code/session-main.jsonl')).join('\n');
    const t0 = performance.now();
    extractiveSummary(readTranscript(big));
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('findClaudeBin respeta CONTEXTPILOT_CLAUDE_BIN=none', () => {
    expect(findClaudeBin({ CONTEXTPILOT_CLAUDE_BIN: 'none', PATH: process.env.PATH })).toBeNull();
  });
});

/** `claude` falso: script .cmd que responde como `claude -p --output-format json`. */
function fakeClaude(dir: string, mode: 'ok' | 'fail'): string {
  const js = join(dir, 'fake-claude.cjs');
  writeFileSync(
    js,
    `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
      require('fs').writeFileSync(${JSON.stringify(join(dir, 'prompt.txt'))}, s);
      if (${JSON.stringify(mode)}==='fail') { process.exit(3); }
      const ok = process.argv.includes('-p') && process.argv.includes('haiku') && process.argv.includes('json');
      process.stdout.write(JSON.stringify({type:'result',is_error:!ok,result:'## Objetivo\\nresumen del modelo',usage:{input_tokens:1200,output_tokens:300},total_cost_usd:0}));
    });`,
  );
  const cmd = join(dir, 'claude.cmd');
  writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  return cmd;
}

describe('POST /handoff', () => {
  it('sin claude → extractivo; con claude → claude-cli; contenido de la extensión sin persistir', async () => {
    const t = await startTestDaemon();
    const proj = join(t.dirs.claude, 'C--repo');
    mkdirSync(proj, { recursive: true });
    const sid = 'handoff-session';
    const file = join(proj, `${sid}.jsonl`);
    writeFileSync(file, transcript(sid));
    t.d.storage.setTranscript(sid, file, 'claude-code');

    const r = (await (await t.api('/handoff', { method: 'POST', json: { sessionId: sid } })).json()) as { summary: string; method: string; command?: string };
    expect(r.method).toBe('extractive');
    expect(r.command).toBe('/clear');
    expect(r.summary).toContain('## Próximos pasos');
    expect(r.summary).not.toContain(SECRET);

    expect((await t.api('/handoff', { method: 'POST', json: {} })).status).toBe(400);
    expect((await t.api('/handoff', { method: 'POST', json: { sessionId: 'sin-transcript' } })).status).toBe(404);

    // contenido desde la extensión: se usa y no se persiste (CP-052.3)
    const WEB = 'texto-de-la-conversacion-web-que-no-se-guarda-77';
    const w = (await (await t.api('/handoff', { method: 'POST', json: { sessionId: 'claude.ai:c1', content: `Usuario: ${WEB}\nAsistente: ok` } })).json()) as { method: string; command?: string; summary: string };
    expect(w.method).toBe('extractive');
    expect(w.command).toBeUndefined();
    expect(w.summary).toContain(WEB);
    t.d.storage.flush();
    expect(readFileSync(join(t.home, 'cp.db')).includes(WEB)).toBe(false);
    await t.close();

    // con un `claude` (falso) disponible
    const bin = tempDir('cp-bin-');
    dirs.push(bin);
    const cmd = fakeClaude(bin, 'ok');
    const t2 = await startTestDaemon({ claudeBin: () => cmd, dirs: { claude: t.dirs.claude } });
    mkdirSync(proj, { recursive: true });
    writeFileSync(file, transcript(sid));
    t2.d.storage.setTranscript(sid, file, 'claude-code');
    const c = (await (await t2.api('/handoff', { method: 'POST', json: { sessionId: sid } })).json()) as { method: string; summary: string };
    expect(c.method).toBe('claude-cli');
    expect(c.summary).toContain('resumen del modelo');
    const prompt = readFileSync(join(bin, 'prompt.txt'), 'utf8');
    expect(prompt).toContain('## Próximos pasos');
    expect(prompt).toContain('USUARIO: Migrá el parser');
    expect(prompt).not.toContain(SECRET);
    // consumo propio registrado (RNF-14)
    const stats = (await (await t2.api('/stats')).json()) as { advisorTokens: number };
    expect(stats.advisorTokens).toBe(1500);
    await t2.close();

    // claude que falla → fallback extractivo
    const bin2 = tempDir('cp-bin-');
    dirs.push(bin2);
    const bad = fakeClaude(bin2, 'fail');
    const t3 = await startTestDaemon({ claudeBin: () => bad });
    writeFileSync(file, transcript(sid));
    t3.d.storage.setTranscript(sid, file, 'claude-code');
    expect(((await (await t3.api('/handoff', { method: 'POST', json: { sessionId: sid } })).json()) as { method: string }).method).toBe('extractive');
    await t3.close();
  }, 30_000);
});

describe('scripts/handoff.mjs (CP-053)', () => {
  it('--print imprime el traspaso con la instrucción de limpieza', async () => {
    const t = await startTestDaemon();
    const proj = join(t.dirs.claude, 'C--repo');
    mkdirSync(proj, { recursive: true });
    const file = join(proj, 'print-session.jsonl');
    writeFileSync(file, transcript('print-session'));
    t.d.storage.setTranscript('print-session', file, 'claude-code');
    const out = await new Promise<string>((resolve) => {
      const c = spawn(process.execPath, [join(ROOT, 'scripts', 'handoff.mjs'), 'print-session', '--print'], {
        env: { ...process.env, CONTEXTPILOT_HOME: t.home, CONTEXTPILOT_PORT: String(t.d.port) },
      });
      let s = '';
      c.stdout.on('data', (d) => (s += d));
      c.on('close', () => resolve(s));
    });
    expect(out).toContain('## Objetivo');
    expect(out).toContain('ejecutá /clear');
    await t.close();
  });

  // Toca el portapapeles real del usuario (lo restaura al final): sólo con CP_TEST_CLIPBOARD=1.
  it.runIf(process.env.CP_TEST_CLIPBOARD === '1')('Set-Clipboard preserva UTF-8 (tildes y ≈)', async () => {
    const ps = (cmd: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
    const prev = ps('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw').stdout;
    const { setClipboard } = await import('../../../scripts/handoff.mjs' as string);
    const text = 'Traspaso: acción ≈45% — sesión «ñandú»';
    setClipboard(text);
    const got = ps('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw').stdout.replace(/\r?\n$/, '');
    if (prev) setClipboard(prev.replace(/\r?\n$/, ''));
    expect(got).toBe(text);
  });
});
