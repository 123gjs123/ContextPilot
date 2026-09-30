import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { applyEvent, validateTurnEvent, type SessionState, type TurnEvent } from '../src/index.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(rel: string): string {
  return readFileSync(join(FIXTURES, rel), 'utf8');
}

/** Evento de respuesta mínimo válido; `over` pisa campos. */
export function ev(over: Partial<TurnEvent> = {}): TurnEvent {
  return {
    id: 'E' + Math.random().toString(36).slice(2),
    source: 'claude-code',
    provider: 'anthropic',
    client: 'cli',
    sessionId: 'S1',
    turn: 1,
    ts: '2026-09-29T10:00:00.000Z',
    model: 'claude-sonnet-4-5',
    tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, estimated: false },
    contextSize: 1000,
    contextWindow: 200_000,
    idleSincePrevMs: 0,
    promptHash: '',
    phase: 'response',
    ...over,
  };
}

/** Aplica una secuencia y devuelve [prev, state] del último evento. */
export function run(events: TurnEvent[], start?: SessionState): { prev?: SessionState; state: SessionState } {
  let prev: SessionState | undefined;
  let state = start;
  for (const e of events) {
    prev = state;
    state = applyEvent(state, e);
  }
  return { prev, state: state! };
}

/** Forma estable (sin id aleatorio ni embedding) para comparar con *.expected.json. */
export function stable(events: TurnEvent[]): unknown[] {
  return events.map(({ id: _id, promptEmbedding, ...rest }) => ({ ...rest, promptEmbedding: promptEmbedding ? promptEmbedding.length : undefined }));
}

/** Compara con `<rel>.expected.json`; con UPDATE_FIXTURES=1 lo (re)escribe. */
export function matchExpected(rel: string, events: TurnEvent[]): void {
  const path = join(FIXTURES, rel + '.expected.json');
  const got = JSON.parse(JSON.stringify(stable(events)));
  if (process.env.UPDATE_FIXTURES === '1' || !existsSync(path)) {
    writeFileSync(path, JSON.stringify(got, null, 2) + '\n');
  }
  expect(got).toEqual(JSON.parse(readFileSync(path, 'utf8')));
}

/** CP-004.3: todo evento emitido por un parser pasa el validador. */
export function expectAllValid(events: TurnEvent[]): void {
  for (const e of events) {
    const r = validateTurnEvent(e);
    if (!r.ok) throw new Error(`evento inválido: ${r.errors.join('; ')}`);
  }
}
