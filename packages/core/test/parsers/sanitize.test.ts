import { describe, expect, it } from 'vitest';
import { ClaudeCodeParser, addTokens, identityTerms, placeholder, sanitizeTranscriptLine, type TurnEvent } from '../../src/index.js';

// D-7 / CP-003.1: sanitizador endurecido (claves, etiquetas, valores de claves de metadato) en core.
// Transcript sintético con identidad en todos los lugares donde la versión anterior la dejaba pasar.

const SID = '11111111-2222-4333-8444-555555555555';
const base = (i: number, extra: object) => ({
  sessionId: SID,
  uuid: `00000000-0000-4000-8000-00000000000${i}`,
  timestamp: `2026-09-29T10:0${i}:00.000Z`,
  cwd: 'C:\\Users\\jdoe\\proyectox',
  gitBranch: 'feature/zanahoria',
  version: '2.1.0',
  ...extra,
});
const usage = (i: number) => ({ input_tokens: 10 * i, output_tokens: 20 * i, cache_read_input_tokens: 1000 * i, cache_creation_input_tokens: 50 });

const LINES = [
  base(1, { type: 'user', message: { role: 'user', content: 'Hola, soy jdoe (jdoe@acme.io). Revisá <proyectox> en C:\\Users\\jdoe\\proyectox\\src' } }),
  base(2, {
    type: 'assistant',
    message: {
      id: 'msg_01',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\Users\\jdoe\\proyectox\\a.ts', type: 'secreto de jdoe' } }],
      usage: usage(1),
    },
  }),
  base(3, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'ENOENT C:\\Users\\jdoe\\proyectox\\a.ts' }] },
    toolUseResult: { type: 'zanahoria', filePath: 'C:\\Users\\jdoe\\proyectox\\a.ts' },
  }),
  { type: 'file-history-snapshot', messageId: 'm1', snapshot: { messageId: 'm1', trackedFileBackups: { 'C:\\Users\\jdoe\\proyectox\\a.ts': { backupFileName: 'abc@v1', version: 1 } } } },
  base(4, { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, answers: { '¿Usamos la base de jdoe?': 'sí' } }),
  base(5, {
    type: 'assistant',
    message: { id: 'msg_02', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Listo jdoe, <usuario>zanahoria</usuario>.' }], usage: usage(2) },
  }),
].map((x) => JSON.stringify(x));

const FORBIDDEN = ['jdoe', 'proyectox', 'zanahoria', 'acme', 'secreto', 'enoent', 'users', 'usamos'];

function parse(lines: string[]): TurnEvent[] {
  const p = new ClaudeCodeParser({ embedPrompts: false });
  return lines.flatMap((l) => p.feed(l));
}

describe('sanitizeTranscriptLine endurecido (D-7)', () => {
  const identity = identityTerms(LINES.map((l) => JSON.parse(l)), ['JDOE-WORKSTATION']);

  it('identityTerms: cwd, rama, emails y sistema; nunca vocabulario del esquema', () => {
    for (const t of ['jdoe', 'proyectox', 'zanahoria', 'acme', 'workstation']) expect(identity.has(t), t).toBe(true);
    for (const t of ['assistant', 'user', 'users', 'type', 'feature']) expect(identity.has(t), t).toBe(t === 'feature');
  });

  it('con identidad: ningún término prohibido sobrevive en claves, etiquetas ni valores', () => {
    const stats = { keys: 0, tags: 0, values: 0 };
    const out = LINES.map((l) => sanitizeTranscriptLine(l, { identity, stats }));
    const tokens = new Set<string>();
    for (const l of out) addTokens(l, tokens, 3);
    for (const f of FORBIDDEN) expect(tokens.has(f), f).toBe(false);
    expect(out.join('\n')).not.toMatch(/[A-Za-z]:\\\\/);
    expect(stats.keys).toBeGreaterThanOrEqual(2); // ruta como clave + pregunta como clave
    expect(stats.tags).toBeGreaterThanOrEqual(3); // <proyectox>, <usuario>, </usuario>
  });

  it('sin identidad (sólo core) tampoco quedan rutas como clave, etiquetas ajenas ni texto libre en `type`', () => {
    const out = LINES.map(sanitizeTranscriptLine);
    const joined = out.join('\n');
    expect(joined).not.toContain('proyectox');
    expect(joined).not.toContain('secreto');
    expect(joined).not.toContain('<usuario>');
    expect(joined).toContain('<command-name>');
    const snap = JSON.parse(out[3]!).snapshot.trackedFileBackups;
    expect(Object.keys(snap)[0]).toMatch(/^x+$/);
    expect(Object.keys(snap)[0]).toHaveLength('C:\\Users\\jdoe\\proyectox\\a.ts'.length);
  });

  it('el parser ve lo mismo: uso, herramientas, fallos, modelos y turnos idénticos', () => {
    const a = parse(LINES);
    const b = parse(LINES.map((l) => sanitizeTranscriptLine(l, { identity })));
    const shape = (evs: TurnEvent[]) => evs.map((e) => ({ phase: e.phase, turn: e.turn, model: e.model, tokens: e.tokens, tools: e.toolCalls?.map((t) => [t.name, t.failed]) }));
    expect(shape(b)).toEqual(shape(a));
  });

  it('igual longitud por string y claves únicas dentro del objeto', () => {
    const rec = { a: { 'k 1': 1, 'k 2': 2, 'k 3': 3 } };
    const out = JSON.parse(sanitizeTranscriptLine(JSON.stringify(rec)));
    expect(Object.keys(out.a)).toHaveLength(3);
    expect(Object.keys(out.a).every((k) => k.length === 3)).toBe(true);
    expect(placeholder('hola <b>mundo</b>')).toBe('xxxx <x>xxxxx</x>');
    expect(placeholder('<system-reminder>x y</system-reminder>')).toBe('<system-reminder>x x</system-reminder>');
  });
});
