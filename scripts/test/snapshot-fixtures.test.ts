import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sanitizeTranscriptLine } from '../../packages/core/src/index.ts';
import * as snap from '../lib/snapshot.ts';
import * as tr from '../lib/transcripts.ts';
import { replay } from '../lib/replay.ts';
// @ts-ignore — módulo JS
import { parseArgs, run } from '../snapshot-fixtures.mjs';

// CP-003.1 / D-7: transcript sintético con datos de identidad en todos los lugares donde el
// sanitizador del core los deja pasar (claves, etiquetas, valores de claves de metadato).
const SID = '11111111-2222-4333-8444-555555555555';
let dir: string;
let projects: string;
let out: string;

const base = (i: number, extra: object) => ({
  sessionId: SID,
  uuid: `00000000-0000-4000-8000-00000000000${i}`,
  timestamp: `2026-09-29T10:0${i}:00.000Z`,
  cwd: 'C:\\Users\\jdoe\\proyectox',
  gitBranch: 'feature/zanahoria',
  version: '2.1.0',
  ...extra,
});
const usage = (i: number) => ({
  input_tokens: 10 * i,
  output_tokens: 20 * i,
  cache_read_input_tokens: 1000 * i,
  cache_creation_input_tokens: 50,
  cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 },
});

function mainLines(): string[] {
  return [
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
      toolUseResult: 'Error: ENOENT zanahoria',
    }),
    { type: 'file-history-snapshot', messageId: 'm1', snapshot: { messageId: 'm1', trackedFileBackups: { 'C:\\Users\\jdoe\\proyectox\\a.ts': { backupFileName: 'abc@v1', version: 1 } } } },
    base(4, {
      type: 'assistant',
      message: { id: 'msg_02', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Listo jdoe, <usuario>zanahoria</usuario>.' }], usage: usage(2) },
    }),
  ].map((x) => JSON.stringify(x));
}

function subLines(): string[] {
  return [
    // El subagente corre dentro del tramo de la sesión principal.
    base(5, { timestamp: '2026-09-29T10:02:30.000Z', type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'subtarea de jdoe' } }),
    base(6, {
      timestamp: '2026-09-29T10:02:40.000Z',
      type: 'assistant',
      isSidechain: true,
      agentId: 'a1',
      message: { id: 'msg_s1', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok proyectox' }], usage: usage(3) },
    }),
  ].map((x) => JSON.stringify(x));
}

const FORBIDDEN = ['jdoe', 'proyectox', 'zanahoria', 'acme', 'secreto', 'ENOENT', 'Users'];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-snap-'));
  projects = join(dir, 'projects');
  out = join(dir, 'out');
  const p = join(projects, 'C--Users-jdoe-proyectox');
  mkdirSync(join(p, SID, 'subagents'), { recursive: true });
  writeFileSync(join(p, `${SID}.jsonl`), mainLines().join('\n') + '\n');
  writeFileSync(join(p, SID, 'subagents', 'agent-a1.jsonl'), subLines().join('\n') + '\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('snapshot-fixtures (CP-003.1)', () => {
  it('lista sesiones con sus subagentes', () => {
    const sets = tr.listTranscriptSets(projects);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.subagents).toHaveLength(1);
    expect(tr.subagentParent(sets[0]!.subagents[0]!)).toBe(SID);
  });

  it('el sanitizador del core ya elimina identidad en claves, tags y valores (fixes-1)', () => {
    const lines = mainLines();
    const identity = snap.identityTerms(lines.map((l) => JSON.parse(l)));
    expect(identity.has('jdoe')).toBe(true);
    expect(identity.has('assistant')).toBe(false); // valor de esquema, no identidad
    const coreOnly = snap.leakCheck(lines, lines.map(sanitizeTranscriptLine), identity);
    expect(coreOnly.ok).toBe(true);
    expect(coreOnly.identityHits).toEqual([]);
  });

  it('dry-run: verifica y no escribe', () => {
    const r = run(parseArgs(['--projects', projects, '--out', out, '--count', '3']), { snap, tr });
    expect(r.mode).toBe('dry-run');
    expect(r.ok).toBe(true);
    expect(r.written).toEqual([]);
    expect(existsSync(out)).toBe(false);
    const s = r.sessions[0];
    expect(s.features).toEqual({ ephemeral1h: true, toolError: true, subagents: 1 });
    expect(s.usageDiff).toEqual([]);
    expect(s.identityHits).toEqual([]);
    expect(s.patternHits).toEqual([]);
    // La capa 2 queda como red de seguridad: el core ya no deja nada para corregir.
    expect(s.harden).toEqual(expect.objectContaining({ keys: 0, tags: 0, values: 0 }));
  });

  it('--write: fixtures sin texto original, mismo uso, placeholders de igual longitud', () => {
    const r = run(parseArgs(['--projects', projects, '--out', out, '--write']), { snap, tr });
    expect(r.ok).toBe(true);
    const main = join(out, 'real-1.jsonl');
    const sub = join(out, 'real-1', 'subagents', 'agent-1.jsonl');
    expect(r.written).toEqual([main, sub, join(out, 'real-1.expected.json')]);
    const text = readFileSync(main, 'utf8') + readFileSync(sub, 'utf8');
    for (const f of FORBIDDEN) expect(text.toLowerCase()).not.toContain(f.toLowerCase());

    // Estructura, usage, ids y timestamps se conservan; el contenido tiene la misma longitud.
    const first = JSON.parse(text.split('\n')[0]!);
    const orig = JSON.parse(mainLines()[0]!);
    expect(first.sessionId).toBe(SID);
    expect(first.timestamp).toBe(orig.timestamp);
    expect(first.message.content).toHaveLength(orig.message.content.length);
    expect(first.cwd).toHaveLength(orig.cwd.length);

    // El replay del fixture da el mismo resultado que el del original.
    const exp = JSON.parse(readFileSync(join(out, 'real-1.expected.json'), 'utf8'));
    expect(exp.usage).toMatchObject({ events: 3, sidechainEvents: 1, input: 60, output: 120, toolCalls: 1, failedToolCalls: 1 });
    const set = tr.listTranscriptSets(projects)[0]!;
    const a = replay([set.main, ...set.subagents]);
    const b = replay([main, sub]);
    expect(b.events.map((e) => e.tokens)).toEqual(a.events.map((e) => e.tokens));
    expect(b.events.filter((e) => e.sidechain)).toHaveLength(1);
  });

  it('no escribe si la verificación falla', () => {
    const bad = { ...snap, leakCheck: () => ({ survivors: [], identityHits: ['jdoe'], patternHits: [], ok: false }) };
    const out2 = join(dir, 'out2');
    const r = run(parseArgs(['--projects', projects, '--out', out2, '--write']), { snap: bad, tr });
    expect(r.ok).toBe(false);
    expect(existsSync(out2)).toBe(false);
  });

  it('boundedLines descarta la última línea incompleta y respeta topes', () => {
    expect(snap.boundedLines('a\nb\nc', { maxLines: 10, maxBytes: 1e6 })).toEqual(['a', 'b']);
    expect(snap.boundedLines('a\nb\nc\n', { maxLines: 2, maxBytes: 1e6 })).toEqual(['a', 'b']);
    expect(snap.boundedLines('aaaa\nbbbb\n', { maxLines: 10, maxBytes: 6 })).toEqual(['aaaa']);
  });

  it('findEmails es lineal con corridas largas de placeholder', () => {
    const s = 'x'.repeat(300_000) + ' a@b.io ' + 'x'.repeat(300_000) + '@';
    const t = Date.now();
    expect(snap.findEmails(s)).toEqual(['a@b.io']);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
