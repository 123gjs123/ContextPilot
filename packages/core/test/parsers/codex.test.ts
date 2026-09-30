import { describe, expect, it } from 'vitest';
import { CodexParser, RuleEngine, applyEvent, codexSessionIdFromPath, parseToolOutput, type SessionState, type TurnEvent } from '../../src/index.js';
import { expectAllValid, fixture, matchExpected } from '../helpers.js';

const FILE = 'codex/rollout-2026-09-29T10-00-00-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl';

function parse(rel: string, p = new CodexParser({ embedPrompts: false })): TurnEvent[] {
  return fixture(rel)
    .split('\n')
    .flatMap((l) => p.feed(l));
}

describe('CodexParser (rollout JSONL)', () => {
  const p = new CodexParser({ embedPrompts: false });
  const events = parse(FILE, p);
  const responses = events.filter((e) => e.phase === 'response');
  const prompts = events.filter((e) => e.phase === 'prompt');

  it('coincide con expected.json', () => matchExpected(FILE, events));

  it('un evento por token_count con info (dedupe de token_count repetido)', () => {
    expect(prompts.length).toBe(2);
    expect(responses.length).toBe(8);
  });

  it('mapea uso: input = input − cached, cacheRead, output, reasoning, exacto', () => {
    const first = responses[0]!;
    expect(first.tokens).toEqual({ input: 12050 - 2048, output: 310, cacheRead: 2048, reasoning: 192, estimated: false });
    expect(first.provider).toBe('openai');
    expect(first.source).toBe('codex');
    expect(first.model).toBe('gpt-5-codex');
    expect(first.contextSize).toBe(12050 + 310);
    expect(first.contextWindow).toBe(272000);
    expect(first.windowSource).toBe('observed');
    expect(first.client).toBe('codex_cli_rs');
    expect(first.sessionId).toBe('5973b6c0-94b8-487b-a530-2aeb6098ae0e');
    // Suma total = total_token_usage final
    const inAll = responses.reduce((s, e) => s + e.tokens.input + (e.tokens.cacheRead ?? 0), 0);
    expect(inAll).toBe(102380);
  });

  it('turnos, pausa y resultados de herramientas adjuntos a la llamada siguiente', () => {
    expect(responses.slice(0, 4).every((e) => e.turn === 1)).toBe(true);
    expect(responses.slice(4).every((e) => e.turn === 2)).toBe(true);
    expect(prompts[1]!.idleSincePrevMs).toBe(Date.parse('2026-09-29T10:12:00Z') - Date.parse('2026-09-29T10:00:30.100Z'));
    expect(responses[4]!.idleSincePrevMs).toBe(prompts[1]!.idleSincePrevMs);
    expect(responses[0]!.toolCalls).toBeUndefined();
    const tc = responses[1]!.toolCalls!;
    expect(tc).toHaveLength(1);
    expect(tc[0]).toMatchObject({ name: 'shell', failed: true });
    expect(responses[2]!.toolCalls![0]).toMatchObject({ name: 'shell', failed: false });
    expect(responses[3]!.toolCalls![0]).toMatchObject({ name: 'apply_patch', failed: false });
  });

  it('function_call_output fallido repetido alimenta R8 (CP-033.4)', () => {
    const eng = new RuleEngine();
    let st: SessionState | undefined;
    const fired: string[] = [];
    for (const e of events) {
      const prev = st;
      st = applyEvent(prev, e);
      for (const s of eng.evaluate({ event: e, prev, state: st, now: Date.parse(e.ts) }).published) fired.push(s.ruleId);
    }
    const loop = responses.flatMap((e) => e.toolCalls ?? []).filter((t) => t.failed && t.name === 'shell');
    expect(loop.length).toBe(4);
    expect(new Set(loop.slice(1).map((t) => t.argsHash)).size).toBe(1);
    expect(fired).toContain('R8');
  });

  it('tolerante: línea no JSON y tipo desconocido se cuentan', () => {
    expect(p.errors).toBe(1);
    expect(p.unknown).toBe(1);
    expect(p.formatVersions.has('0.42.0')).toBe(true);
  });

  it('todos los eventos pasan el validador', () => expectAllValid(events));

  it('formato legado: prompt sin instrucciones inyectadas, sin uso', () => {
    const lp = new CodexParser({ sessionId: 'legacy-1', embedPrompts: false });
    const evs = parse('codex/rollout-legacy.jsonl', lp);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.phase).toBe('prompt');
    expect(evs[0]!.sessionId).toBe('legacy-1');
    expect(lp.formatVersions.has('legacy')).toBe(true);
  });

  it('sessionId desde el nombre de archivo', () => {
    expect(codexSessionIdFromPath('C:/x/.codex/sessions/2026/09/29/' + FILE.split('/')[1])).toBe('5973b6c0-94b8-487b-a530-2aeb6098ae0e');
    expect(codexSessionIdFromPath('otro.jsonl')).toBeUndefined();
  });

  it('parseToolOutput: variantes de salida', () => {
    expect(parseToolOutput('Exit code: 3\nOutput:\nx').failed).toBe(true);
    expect(parseToolOutput({ content: 'x', success: false }).failed).toBe(true);
    expect(parseToolOutput('{"output":"ok","metadata":{"exit_code":0}}')).toEqual({ text: 'ok', failed: false });
    expect(parseToolOutput(undefined).failed).toBe(false);
  });
});
