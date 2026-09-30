import { describe, expect, it } from 'vitest';
import { createWebStreamParser, type WebSite } from '../../src/index.js';
import { fixture } from '../helpers.js';

function feed(site: WebSite, text: string, chunk = 9) {
  const p = createWebStreamParser(site);
  for (let i = 0; i < text.length; i += chunk) p.push(text.slice(i, i + chunk));
  return p;
}

describe('claude.ai', () => {
  it('formato Messages-like: texto, modelo, uuid, thinking aparte, done', () => {
    const r = feed('claude.ai', fixture('web/claude-ai.sse')).result();
    expect(r).toEqual({
      text: '¡Hola! ¿Cómo va todo?',
      model: 'claude-sonnet-4-5-20250929',
      done: true,
      messageId: '0f3c1a2b-0000-4000-8000-00000000bbbb',
      reasoningText: 'El usuario pide un saludo.',
    });
  });

  it('formato legado completion', () => {
    const r = feed('claude.ai', fixture('web/claude-ai-legacy.sse'), 4).result();
    expect(r.text).toBe('Hola, ¿qué tal?');
    expect(r.model).toBe('claude-2.1');
    expect(r.done).toBe(true);
  });

  it('stream a medias: done=false', () => {
    const text = fixture('web/claude-ai.sse');
    const r = feed('claude.ai', text.slice(0, text.indexOf('message_delta'))).result();
    expect(r.done).toBe(false);
    expect(r.text).toBe('¡Hola! ¿Cómo va todo?');
  });
});

describe('chatgpt.com', () => {
  it('delta encoding v1: add/append/{v}/patch, ignora user y thoughts en el texto', () => {
    const r = feed('chatgpt.com', fixture('web/chatgpt-delta.sse'), 17).result();
    expect(r.text).toBe('X es una letra del alfabeto.');
    expect(r.model).toBe('gpt-5-thinking');
    expect(r.messageId).toBe('a-0003');
    expect(r.done).toBe(true);
    expect(r.conversationId).toBe('68ab0000-0000-4000-8000-00000000c0de');
    expect(r.reasoningText).toBe('Pienso en X.');
  });

  it('formato acumulativo legado: el último estado gana', () => {
    const r = feed('chatgpt.com', fixture('web/chatgpt-cumulative.sse'), 23).result();
    expect(r).toMatchObject({ text: 'Hola, ¿cómo estás?', model: 'gpt-4o', messageId: 'a-1001', done: true });
  });

  it('tolera basura y no lanza', () => {
    const p = createWebStreamParser('chatgpt.com');
    p.push('data: {roto\n\ndata: 12\n\ndata: {"v": "suelto"}\n\n');
    expect(p.result().done).toBe(false);
  });
});
