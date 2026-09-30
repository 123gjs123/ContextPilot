import { describe, expect, it } from 'vitest';
import { ClaudeCodeParser, applyEvent, sanitizeTranscriptLine, placeholder, type SessionState, type TurnEvent } from '../../src/index.js';
import { expectAllValid, fixture } from '../helpers.js';

const MAIN = 'claude-code/session-main.jsonl';
const SUB = 'claude-code/session-subagent.jsonl';

function parseAll(text: string, p = new ClaudeCodeParser({ embedPrompts: false })): TurnEvent[] {
  return text.split('\n').flatMap((l) => p.feed(l));
}

/** Suma independiente de usage deduplicada por message.id (CP-030.4). */
function independentSum(text: string, sidechain: boolean) {
  const seen = new Set<string>();
  let total = 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.type !== 'assistant' || !!r.isSidechain !== sidechain) continue;
    const m = r.message;
    if (!m?.id || !m.usage || m.model === '<synthetic>' || seen.has(m.id)) continue;
    seen.add(m.id);
    count++;
    const u = m.usage;
    total += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  return { total, count };
}

const sumEvents = (evs: TurnEvent[]) =>
  evs.reduce((s, e) => s + e.tokens.input + e.tokens.output + (e.tokens.cacheRead ?? 0) + (e.tokens.cacheWrite ?? 0), 0);

describe('ClaudeCodeParser (fixture sanitizado de transcript real)', () => {
  const text = fixture(MAIN);
  const events = parseAll(text);
  const responses = events.filter((e) => e.phase === 'response');

  it('fixture no contiene texto real (placeholders)', () => {
    const r = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((x) => x.type === 'user' && Array.isArray(x.message?.content) && x.message.content[0]?.type === 'text');
    expect(r.message.content[0].text).toMatch(/^[x\s<>/a-z_-]*$/);
  });

  it('deduplica por message.id: un evento por mensaje de API y suma exacta de usage', () => {
    const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const assistantLines = lines.filter((l) => l.type === 'assistant').length;
    const { total, count } = independentSum(text, false);
    expect(assistantLines).toBeGreaterThan(count); // hay líneas repetidas por message.id
    expect(responses.length).toBe(count);
    expect(sumEvents(responses)).toBe(total);
  });

  it('marca exacto, TTL 1h inferido de ephemeral_1h y turnos por prompt', () => {
    expect(responses.every((e) => e.tokens.estimated === false)).toBe(true);
    expect(responses.some((e) => e.cacheTtlMs === 60 * 60_000)).toBe(true);
    expect(events.filter((e) => e.phase === 'prompt').length).toBeGreaterThan(0);
    expect(responses.every((e) => e.windowSource === 'table' || e.windowSource === 'observed')).toBe(true);
  });

  it('tool_result is_error → toolCall failed, con argsHash', () => {
    const calls = responses.flatMap((e) => e.toolCalls ?? []);
    expect(calls.some((c) => c.failed)).toBe(true);
    expect(calls.every((c) => c.name && typeof c.argsHash === 'string')).toBe(true);
  });

  it('todos los eventos pasan el validador', () => expectAllValid(events));

  it('registra formatVersion y tolera líneas inválidas', () => {
    const p = new ClaudeCodeParser();
    parseAll(text + '\nno json\n{"type":"weird","version":"9.9.9"}\n', p);
    expect(p.formatVersions.has('2.1.179')).toBe(true);
    expect(p.formatVersions.has('9.9.9')).toBe(true);
    expect(p.errors).toBe(1);
  });
});

describe('ClaudeCodeParser subagentes (DECISIONS «subagentes»)', () => {
  const sub = fixture(SUB);

  it('archivo de subagente → eventos sidechain con sessionId del padre', () => {
    const p = new ClaudeCodeParser({ sidechain: true, parentSessionId: 'PARENT', embedPrompts: false });
    const evs = parseAll(sub, p);
    const { total, count } = independentSum(sub, true);
    expect(evs.length).toBe(count);
    expect(evs.every((e) => e.sidechain === true && e.sessionId === 'PARENT' && e.phase === 'response')).toBe(true);
    expect(sumEvents(evs)).toBe(total);
    expect(evs.flatMap((e) => e.toolCalls ?? []).length).toBeGreaterThan(0);
    expectAllValid(evs);
  });

  it('isSidechain sin opción: se emiten como sidechain con el sessionId del registro', () => {
    const evs = parseAll(sub);
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.sidechain && e.sessionId === 'c7801ad4-b2b4-4b2d-a8c2-effbec73583e')).toBe(true);
  });

  it('aplicados sobre la sesión padre: suman totales sin tocar contextSize', () => {
    const main = parseAll(fixture(MAIN));
    let st: SessionState | undefined;
    for (const e of main) st = applyEvent(st, e);
    const before = structuredClone(st!);
    const subEvs = parseAll(sub, new ClaudeCodeParser({ sidechain: true, embedPrompts: false }));
    for (const e of subEvs) st = applyEvent(st, e);
    expect(st!.contextSize).toBe(before.contextSize);
    expect(st!.cacheRatios).toEqual(before.cacheRatios);
    expect(st!.turns).toBe(before.turns);
    const added = subEvs.reduce((s, e) => s + e.tokens.input, 0);
    expect(st!.totals.input).toBe(before.totals.input + added);
  });

  it('líneas normales mantienen el comportamiento (sin sidechain)', () => {
    const evs = parseAll(fixture(MAIN));
    expect(evs.some((e) => e.sidechain)).toBe(false);
  });
});

describe('sanitizeTranscriptLine', () => {
  it('conserva usage/ids/modelo/nombre de herramienta y reemplaza contenido con igual longitud', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'abc',
      cwd: 'C:\\Users\\alguien\\secreto',
      message: {
        id: 'msg_1',
        model: 'claude-opus-4',
        content: [
          { type: 'text', text: 'hola mundo secreto' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat .env' } },
        ],
        usage: { input_tokens: 3, output_tokens: 5 },
      },
    });
    const out = JSON.parse(sanitizeTranscriptLine(line));
    expect(out.sessionId).toBe('abc');
    expect(out.message.model).toBe('claude-opus-4');
    expect(out.message.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
    expect(out.message.content[1].name).toBe('Bash');
    expect(out.message.content[0].text).toBe('xxxx xxxxx xxxxxxx');
    expect(out.message.content[1].input.command).toBe('xxx xxxx');
    expect(out.cwd).not.toContain('alguien');
    expect(placeholder('<command-name>/x</command-name>')).toBe('<command-name>xx</command-name>');
  });
});
