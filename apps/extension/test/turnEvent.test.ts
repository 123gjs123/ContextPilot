import { contextWindowFor, estimateTokens, validateTurnEvent } from '@contextpilot/core';
import { describe, expect, it } from 'vitest';
import { buildTurnEvent, promptHashOf } from '../src/turnEvent.js';

const base = {
  site: 'claude.ai' as const,
  conversationId: '0f3c9a1e-1111',
  turn: 2,
  answerText: 'Respuesta del asistente con algunas palabras más para contar.',
  priorText: 'Usuario: hola\n\nAsistente: hola, ¿en qué te ayudo?\n\nUsuario: explicame índices',
  promptText: 'explicame índices',
  now: Date.parse('2026-09-30T12:00:00Z'),
  via: 'net' as const,
};

describe('buildTurnEvent', () => {
  it('arma un TurnEvent web estimado con sesión <sitio>:<id>', () => {
    const ev = buildTurnEvent({ ...base, model: 'claude-sonnet-4-5-20250929', prevTs: base.now - 60_000 });
    expect(ev).toMatchObject({
      source: 'web',
      provider: 'anthropic',
      client: 'claude.ai',
      sessionId: 'claude.ai:0f3c9a1e-1111',
      turn: 2,
      model: 'claude-sonnet-4-5-20250929',
      contextWindow: 200_000,
      idleSincePrevMs: 60_000,
      phase: 'response',
      ts: '2026-09-30T12:00:00.000Z',
    });
    expect(ev.tokens.estimated).toBe(true);
    // El prompt ya está en priorText: no se cuenta dos veces
    expect(ev.tokens.input).toBe(estimateTokens(base.priorText, 'anthropic'));
    expect(ev.tokens.output).toBe(estimateTokens(base.answerText, 'anthropic'));
    expect(ev.contextSize).toBe(ev.tokens.input + ev.tokens.output);
    expect(ev.promptTokens).toBe(estimateTokens('explicame índices', 'anthropic'));
    expect(ev.promptHash).toBe(promptHashOf('  explicame   índices '));
    expect(ev.promptEmbedding).toHaveLength(256);
    expect(ev.id).toHaveLength(26);
  });

  it('suma el prompt si todavía no estaba renderizado y los adjuntos', () => {
    const ev = buildTurnEvent({ ...base, priorText: 'Usuario: hola', attachments: [{ hash: 'abc', tokens: 1000 }] });
    expect(ev.tokens.input).toBe(estimateTokens('Usuario: hola', 'anthropic') + estimateTokens('explicame índices', 'anthropic') + 1000);
    expect(ev.attachments).toEqual([{ hash: 'abc', tokens: 1000 }]);
  });

  it('redacta secretos antes de embeber y de calcular bloques; nunca incluye el texto', () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(40);
    const big = `Mirá este log:\n\n${'línea de log con datos '.repeat(200)}\n\nclave ${secret}`;
    const ev = buildTurnEvent({ ...base, promptText: big, priorText: '' });
    expect(JSON.stringify(ev)).not.toContain(secret);
    expect(JSON.stringify(ev)).not.toContain('línea de log');
    expect(ev.blocks?.length).toBeGreaterThan(0);
  });

  it('modelo desconocido → default del sitio; regenerated/expensiveMode/reasoning', () => {
    const ev = buildTurnEvent({
      ...base,
      site: 'gemini.google.com',
      model: undefined,
      regenerated: true,
      expensiveMode: 'deep-research',
      reasoningText: 'pensando en voz alta sobre el problema',
    });
    expect(ev.provider).toBe('google');
    expect(ev.model).toBe('gemini');
    expect(ev.contextWindow).toBe(contextWindowFor('gemini', 'google'));
    expect(ev.regenerated).toBe(true);
    expect(ev.expensiveMode).toBe('deep-research');
    expect(ev.tokens.reasoning).toBeGreaterThan(0);
    expect(ev.contextSize).toBe(ev.tokens.input + ev.tokens.output); // el razonamiento no queda en contexto
  });

  it('chatgpt: ventana del modelo desde la tabla de core', () => {
    const ev = buildTurnEvent({ ...base, site: 'chatgpt.com', model: 'gpt-4o' });
    expect(ev.provider).toBe('openai');
    expect(ev.contextWindow).toBe(128_000);
  });

  it('los eventos pasan el validador de core que usa POST /ingest/events', () => {
    for (const site of ['claude.ai', 'chatgpt.com', 'gemini.google.com'] as const) {
      const ev = buildTurnEvent({ ...base, site, attachments: [{ hash: 'ab', tokens: 3 }], regenerated: true, expensiveMode: 'x', reasoningText: 'r' });
      const r = validateTurnEvent(JSON.parse(JSON.stringify(ev)));
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });
});
