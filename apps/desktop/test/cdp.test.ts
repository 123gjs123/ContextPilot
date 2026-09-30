import { describe, expect, it } from 'vitest';
import { ClaudeDesktopCapture, COMPLETION_RE } from '../src/cdp/capture.js';
import { assertReadOnly, REFUSAL_RE } from '../src/cdp/claudeDesktop.js';
import { createLocalClaudeParser } from '../src/cdp/claudeSse.js';
import type { TurnEvent } from '@contextpilot/core';

// CP-043.1: CDP simulado con mensajes Network.* y el mismo SSE de claude.ai.

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-5","role":"assistant"}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hola, esto es una respuesta "}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"de prueba con varias palabras."}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const URL_BASE = 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-42';

function simulate(opts: { base64?: boolean; failBody?: boolean } = {}) {
  const emitted: TurnEvent[] = [];
  let t = Date.parse('2026-09-30T10:00:00Z');
  const bodies = new Map<string, string>();
  const cap = new ClaudeDesktopCapture({
    getResponseBody: async (id) => {
      if (opts.failBody) throw new Error('No resource with given identifier');
      const b = bodies.get(id)!;
      return opts.base64 ? { body: Buffer.from(b).toString('base64'), base64Encoded: true } : { body: b, base64Encoded: false };
    },
    emit: (evs) => {
      emitted.push(...evs);
    },
    now: () => t,
  });
  const turn = async (reqId: string, url: string, prompt: string, advanceMs = 60_000) => {
    t += advanceMs;
    bodies.set(reqId, SSE);
    cap.onEvent('Network.requestWillBeSent', {
      requestId: reqId,
      request: { url, method: 'POST', postData: JSON.stringify({ prompt, attachments: [{ extracted_content: 'adjunto de texto' }] }) },
    });
    cap.onEvent('Network.responseReceived', { requestId: reqId, response: { mimeType: 'text/event-stream' } });
    cap.onEvent('Network.loadingFinished', { requestId: reqId });
    await new Promise((r) => setTimeout(r, 0));
  };
  return { cap, emitted, turn };
}

describe('adaptador Claude Desktop vía CDP (CP-043)', () => {
  it('patrón de endpoint de completion', () => {
    expect(COMPLETION_RE.exec(`${URL_BASE}/completion`)?.[1]).toBe('conv-42');
    expect(COMPLETION_RE.test(`${URL_BASE}/retry_completion`)).toBe(true);
    expect(COMPLETION_RE.test(`${URL_BASE}/completion2?x=1`)).toBe(true);
    expect(COMPLETION_RE.test(`${URL_BASE}`)).toBe(false);
    expect(COMPLETION_RE.test('https://claude.ai/api/organizations/o/projects/p')).toBe(false);
  });

  it('emite TurnEvent source=desktop, client=claude-desktop, estimado', async () => {
    const { emitted, turn } = simulate();
    await turn('r1', `${URL_BASE}/completion`, 'Explicame los fuses de Electron por favor');
    expect(emitted).toHaveLength(1);
    const e = emitted[0]!;
    expect(e).toMatchObject({ source: 'desktop', client: 'claude-desktop', provider: 'anthropic', sessionId: 'claude-desktop:conv-42', turn: 1, model: 'claude-sonnet-4-5', contextWindow: 200_000 });
    expect(e.tokens.estimated).toBe(true);
    expect(e.tokens.output).toBeGreaterThan(5);
    expect(e.promptTokens).toBeGreaterThan(3);
    expect(e.attachments).toHaveLength(1);
    expect(e.promptHash).toMatch(/^[0-9a-f]+$/);
    // Sin contenido en el evento (RNF-01).
    expect(JSON.stringify(e)).not.toContain('fuses');
    expect(JSON.stringify(e)).not.toContain('Hola');
  });

  it('acumula contexto por conversación, idle y turnos; retry no suma turno', async () => {
    const { emitted, turn } = simulate();
    await turn('r1', `${URL_BASE}/completion`, 'uno');
    await turn('r2', `${URL_BASE}/completion`, 'dos', 120_000);
    await turn('r3', `${URL_BASE}/retry_completion`, 'dos', 5_000);
    const [a, b, c] = emitted;
    expect(b!.turn).toBe(2);
    expect(b!.contextSize).toBeGreaterThan(a!.contextSize);
    expect(b!.idleSincePrevMs).toBe(120_000);
    expect(c!.turn).toBe(2);
    expect(c!.regenerated).toBe(true);
    expect(c!.contextSize).toBe(b!.contextSize);
  });

  it('cuerpos base64 y requests ajenos', async () => {
    const { cap, emitted, turn } = simulate({ base64: true });
    cap.onEvent('Network.requestWillBeSent', { requestId: 'x', request: { url: 'https://claude.ai/api/foo', method: 'GET' } });
    cap.onEvent('Network.loadingFinished', { requestId: 'x' });
    await turn('r1', `${URL_BASE}/completion`, 'hola');
    expect(emitted).toHaveLength(1);
  });

  it('si no se puede leer el cuerpo, no emite y cuenta error', async () => {
    const { cap, emitted, turn } = simulate({ failBody: true });
    await turn('r1', `${URL_BASE}/completion`, 'hola');
    expect(emitted).toHaveLength(0);
    expect(cap.errors).toBe(1);
  });

  it('sólo lectura: métodos que alteran la página están prohibidos (CP-043.3)', () => {
    expect(() => assertReadOnly('Network.enable')).not.toThrow();
    expect(() => assertReadOnly('Network.getResponseBody')).not.toThrow();
    for (const m of ['Runtime.evaluate', 'Input.dispatchKeyEvent', 'Page.navigate', 'Network.setRequestInterception', 'Fetch.enable']) {
      expect(() => assertReadOnly(m)).toThrow(/no permitido/);
    }
  });

  it('detecta el rechazo del switch observado en el spike', () => {
    expect(REFUSAL_RE.test('Claude: refusing to start — a debugging or network-override switch is present on the command line.')).toBe(true);
  });

  it('parser SSE local tolera chunks partidos y thinking', () => {
    const p = createLocalClaudeParser();
    const s = SSE + 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"pensando"}}\n\n';
    for (let i = 0; i < s.length; i += 7) p.push(s.slice(i, i + 7));
    const r = p.end();
    expect(r.outputText).toBe('Hola, esto es una respuesta de prueba con varias palabras.');
    expect(r.thinkingText).toBe('pensando');
    expect(r.stopReason).toBe('end_turn');
  });
});
