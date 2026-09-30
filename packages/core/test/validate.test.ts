import { describe, expect, it } from 'vitest';
import { validateSuggestion, validateTurnEvent } from '../src/index.js';
import { ev } from './helpers.js';

describe('validateTurnEvent (CP-004)', () => {
  it('evento válido pasa y conserva campos conocidos', () => {
    const e = ev({ toolCalls: [{ name: 'Bash', resultTokens: 3, failed: true, argsHash: 'x' }], sidechain: true, windowSource: 'table' });
    const r = validateTurnEvent(e);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event).toEqual(e);
  });

  it('completa id y ts si faltan', () => {
    const { id: _id, ts: _ts, ...rest } = ev();
    const r = validateTurnEvent(rest, Date.parse('2026-09-29T10:00:00Z'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.id).toHaveLength(26);
      expect(r.event.ts).toBe('2026-09-29T10:00:00.000Z');
    }
  });

  it('rechaza sin sessionId o sin tokens.estimated, con nombre de campo', () => {
    const { sessionId: _s, ...noSession } = ev();
    const r1 = validateTurnEvent(noSession);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.join()).toContain('sessionId');
    const r2 = validateTurnEvent({ ...ev(), tokens: { input: 1, output: 1 } });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.join()).toContain('tokens.estimated');
  });

  it('rechaza enums, números negativos, ts inválido y opcionales mal formados', () => {
    const bad = validateTurnEvent({
      ...ev(),
      source: 'fax',
      provider: 'x',
      contextSize: -1,
      ts: 'ayer',
      toolCalls: [{ name: 1 }],
      attachments: 'no',
      phase: 'otro',
      promptEmbedding: ['a'],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const msg = bad.errors.join('|');
      for (const f of ['source', 'provider', 'contextSize', 'ts', 'toolCalls[0]', 'attachments', 'phase', 'promptEmbedding']) expect(msg).toContain(f);
    }
    expect(validateTurnEvent(null).ok).toBe(false);
    expect(validateTurnEvent([]).ok).toBe(false);
  });

  it('descarta campos desconocidos (no persiste contenido inesperado)', () => {
    const r = validateTurnEvent({ ...ev(), promptText: 'secreto' });
    expect(r.ok && 'promptText' in r.event).toBe(false);
  });
});

describe('validateSuggestion (CP-004.2)', () => {
  const s = {
    id: '01J',
    ruleId: 'R1',
    sessionId: 'S',
    severity: 'warn',
    title: 't',
    detail: 'd',
    actions: [{ kind: 'copy', label: 'Copiar', payload: '/compact' }],
    expiresAt: '2026-09-29T10:10:00Z',
  };
  it('acepta con ≥ 1 acción; rechaza actions vacío o kind inválido', () => {
    expect(validateSuggestion(s).ok).toBe(true);
    const r = validateSuggestion({ ...s, actions: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('actions');
    expect(validateSuggestion({ ...s, actions: [{ kind: 'send', label: 'x' }] }).ok).toBe(false);
    expect(validateSuggestion({ ...s, severity: 'high' }).ok).toBe(false);
  });
});
