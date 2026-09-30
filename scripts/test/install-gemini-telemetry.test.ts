import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-ignore — módulo JS
import { lineDiff, run, stripJsonComments } from '../install-gemini-telemetry.mjs';

// CP-034.3: siempre contra un HOME temporal (--home); nunca contra el home real.
let home: string;
let settings: string;
const quiet = () => {};
const read = () => JSON.parse(readFileSync(settings, 'utf8'));
const outfile = () => join(home, '.gemini', 'telemetry.log').replace(/\\/g, '/');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cp-gemini-'));
  settings = join(home, '.gemini', 'settings.json');
  expect(home).not.toBe(homedir());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('install-gemini-telemetry (CP-034.3)', () => {
  it('sin settings previo: crea el bloque telemetry con outfile y logPrompts=false', () => {
    const r = run(['--home', home], quiet);
    expect(r).toMatchObject({ code: 0, changed: true, written: true });
    expect(read()).toEqual({
      telemetry: { enabled: true, target: 'local', otlpEndpoint: '', outfile: outfile(), logPrompts: false },
    });
    expect(existsSync(settings + '.cp-bak')).toBe(false); // no había nada que respaldar
  });

  it('conserva el resto de settings, hace backup una vez y es idempotente', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    const original = JSON.stringify({ theme: 'GitHub', general: { vimMode: true }, telemetry: { useCollector: false, target: 'gcp' } }, null, 2);
    writeFileSync(settings, original);
    expect(run(['--home', home], quiet).changed).toBe(true);
    const s = read();
    expect(s.theme).toBe('GitHub');
    expect(s.general).toEqual({ vimMode: true });
    expect(s.telemetry).toEqual({ useCollector: false, target: 'local', enabled: true, otlpEndpoint: '', outfile: outfile(), logPrompts: false });
    expect(readFileSync(settings + '.cp-bak', 'utf8')).toBe(original);

    const again = run(['--home', home], quiet);
    expect(again).toMatchObject({ code: 0, changed: false });
    expect(readFileSync(settings + '.cp-bak', 'utf8')).toBe(original); // el backup no se pisa
  });

  it('--dry-run muestra el diff y no escribe', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(settings, '{ "theme": "Default" }');
    const lines: string[] = [];
    const r = run(['--home', home, '--dry-run'], (l: string) => lines.push(l));
    expect(r).toMatchObject({ code: 0, changed: true, written: false });
    expect(r.diff).toContain('+   "telemetry": {');
    expect(r.diff).toContain('+     "logPrompts": false');
    expect(lines.join('\n')).toContain('dry-run');
    expect(readFileSync(settings, 'utf8')).toBe('{ "theme": "Default" }');
    expect(existsSync(settings + '.cp-bak')).toBe(false);
  });

  it('acepta settings con comentarios (formato de Gemini CLI)', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(settings, '{\n  // tema\n  "theme": "Dracula", /* url: "http://x" */ "u": "http://no-es-comentario"\n}');
    const r = run(['--home', home], quiet);
    expect(r.code).toBe(0);
    expect(read()).toMatchObject({ theme: 'Dracula', u: 'http://no-es-comentario', telemetry: { enabled: true } });
    expect(stripJsonComments('{"a":"//x"} // c')).toBe('{"a":"//x"} \n');
  });

  it('--uninstall restaura el bloque previo del backup', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ theme: 'X', telemetry: { enabled: false } }));
    run(['--home', home], quiet);
    const r = run(['--home', home, '--uninstall'], quiet);
    expect(r.changed).toBe(true);
    expect(read()).toEqual({ theme: 'X', telemetry: { enabled: false } });
    expect(run(['--home', home, '--uninstall'], quiet).changed).toBe(false);
  });

  it('--uninstall sin telemetry previo quita el bloque; no toca un bloque ajeno', () => {
    run(['--home', home], quiet);
    run(['--home', home, '--uninstall'], quiet);
    expect(read()).toEqual({});

    writeFileSync(settings, JSON.stringify({ telemetry: { enabled: true, target: 'gcp', logPrompts: true } }));
    expect(run(['--home', home, '--uninstall'], quiet).changed).toBe(false);
    expect(read().telemetry.target).toBe('gcp');
  });

  it('--otlp configura el exportador HTTP al daemon sin outfile', () => {
    run(['--home', home, '--otlp'], quiet);
    expect(read().telemetry).toEqual({ enabled: true, target: 'local', otlpEndpoint: 'http://127.0.0.1:47800/otlp', otlpProtocol: 'http', logPrompts: false });
    run(['--home', home, '--uninstall'], quiet);
    expect(read()).toEqual({});
  });

  it('--outfile y --settings explícitos', () => {
    const custom = join(home, 'otro', 'settings.json');
    run(['--settings', custom, '--outfile', join(home, 'tel.log')], quiet);
    expect(JSON.parse(readFileSync(custom, 'utf8')).telemetry.outfile).toBe(join(home, 'tel.log').replace(/\\/g, '/'));
  });

  it('JSON inválido: código 2 y no modifica', () => {
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(settings, '{ roto');
    expect(run(['--home', home], quiet).code).toBe(2);
    expect(readFileSync(settings, 'utf8')).toBe('{ roto');
  });

  it('lineDiff marca altas y bajas', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toBe('  a\n- b\n  c\n+ d');
  });
});
