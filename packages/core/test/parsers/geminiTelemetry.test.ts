import { describe, expect, it } from 'vitest';
import { GeminiOutfileSplitter, GeminiTelemetryParser, attrsOf, parseGeminiOutfile, type TurnEvent } from '../../src/index.js';
import { expectAllValid, fixture, matchExpected } from '../helpers.js';

const SID = 'b8a0f1e2-7c3d-4e5f-9a1b-2c3d4e5f6a7b';

describe('parseGeminiOutfile', () => {
  it('separa objetos JSON indentados concatenados (con llaves dentro de strings)', () => {
    const recs = parseGeminiOutfile(fixture('gemini-cli/telemetry.log'));
    expect(recs).toHaveLength(10);
  });

  it('versión incremental: objeto partido entre chunks', () => {
    const text = fixture('gemini-cli/telemetry.log');
    const s = new GeminiOutfileSplitter();
    const out: unknown[] = [];
    for (let i = 0; i < text.length; i += 37) out.push(...s.push(text.slice(i, i + 37)));
    expect(out).toHaveLength(10);
  });
});

describe('GeminiTelemetryParser', () => {
  const p = new GeminiTelemetryParser({ embedPrompts: false });
  const events: TurnEvent[] = parseGeminiOutfile(fixture('gemini-cli/telemetry.log')).flatMap((r) => p.feed(r));
  const responses = events.filter((e) => e.phase === 'response');

  it('coincide con expected.json', () => matchExpected('gemini-cli/telemetry.log', events));

  it('un evento por api_response con uso exacto (input = prompt − cached)', () => {
    expect(responses).toHaveLength(3);
    expect(responses[1]!.tokens).toEqual({ input: 15600 - 14336, output: 180, cacheRead: 14336, reasoning: 120, estimated: false });
    expect(responses[1]!.contextSize).toBe(15600 + 45 + 180);
    expect(responses[0]!.sessionId).toBe(SID);
    expect(responses[0]!.model).toBe('gemini-2.5-pro');
    expect(responses[0]!.provider).toBe('google');
    expect(responses[0]!.source).toBe('gemini-cli');
    expect(p.formatVersions.has('0.8.2')).toBe(true);
  });

  it('tool_call → toolCalls de la siguiente respuesta; success=false → failed', () => {
    expect(responses[0]!.toolCalls).toBeUndefined();
    expect(responses[1]!.toolCalls!.map((t) => [t.name, t.failed])).toEqual([
      ['read_file', false],
      ['run_shell_command', true],
    ]);
  });

  it('turnos por prompt_id y pausa', () => {
    expect(responses.map((e) => e.turn)).toEqual([1, 1, 2]);
    const prompts = events.filter((e) => e.phase === 'prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.promptTokens).toBe(16);
    expect(prompts[1]!.idleSincePrevMs).toBe(Date.parse('2026-09-29T10:20:00Z') - Date.parse('2026-09-29T10:00:15.200Z'));
  });

  it('OTLP/HTTP JSON produce los mismos eventos que el archivo', () => {
    const q = new GeminiTelemetryParser({ embedPrompts: false });
    const otlp = q.feed(JSON.parse(fixture('gemini-cli/otlp-logs.json')));
    const strip = (e: TurnEvent[]) => e.map(({ id: _i, ...r }) => r);
    // Las respuestas son idénticas; el prompt difiere sólo en el modelo (el archivo trae gemini_cli.config antes).
    expect(strip(otlp.filter((e) => e.phase === 'response'))).toEqual(strip(responses.slice(0, 2)));
    expect(otlp[0]).toMatchObject({ phase: 'prompt', promptHash: events[0]!.promptHash, promptTokens: 16, turn: 1 });
    // Reenvío idéntico (reintento OTLP) no duplica.
    expect(q.feed(JSON.parse(fixture('gemini-cli/otlp-logs.json')))).toHaveLength(0);
  });

  it('tolerante a basura', () => {
    const q = new GeminiTelemetryParser();
    expect(q.feed(null)).toEqual([]);
    expect(q.feed(42)).toEqual([]);
    expect(q.feed({ attributes: { 'event.name': 'otro' } })).toEqual([]);
    expect(q.ignored).toBe(3);
  });

  it('attrsOf convierte AnyValue OTLP', () => {
    expect(attrsOf([{ key: 'a', value: { intValue: '5' } }, { key: 'b', value: { boolValue: false } }])).toEqual({ a: 5, b: false });
  });

  it('todos los eventos pasan el validador', () => expectAllValid(events));
});
