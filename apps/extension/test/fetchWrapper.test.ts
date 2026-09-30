// CP-038 / CP-058(b): el wrapper de fetch no altera lo que lee la página y es transparente para
// URLs que no son de conversación.
import { describe, expect, it, vi } from 'vitest';
import type { BridgePayload, NetDoneMsg, NetStartMsg } from '../src/bridge.js';
import { describeRequest, installFetchWrapper, type WebStreamParser } from '../src/capture/fetchWrapper.js';
import { chunkedStream, fixture } from './helpers.js';

const CLAUDE_URL = 'https://claude.ai/api/organizations/org-1/chat_conversations/0f3c9a1e-1111-2222-3333-444444444444/completion';

function recordingParser() {
  const chunks: string[] = [];
  const p: WebStreamParser & { chunks: string[] } = {
    chunks,
    push: (c) => void chunks.push(c),
    result: () => ({ text: chunks.join(''), done: true, model: 'fake-model' }),
  };
  return p;
}

function setup(site: 'claude.ai' | 'chatgpt.com', upstream: (...a: unknown[]) => Promise<Response>) {
  const posted: BridgePayload[] = [];
  const parsers: ReturnType<typeof recordingParser>[] = [];
  const original = vi.fn(upstream);
  const win = { fetch: original as unknown as typeof fetch, location: { href: `https://${site}/chat/x` } };
  const uninstall = installFetchWrapper(win, {
    site,
    post: (m) => void posted.push(m),
    createParser: () => {
      const p = recordingParser();
      parsers.push(p);
      return p;
    },
  });
  const waitDone = async () => {
    for (let i = 0; i < 50 && !posted.some((m) => m.kind === 'net-done'); i++) await new Promise((r) => setTimeout(r, 2));
    return posted.find((m) => m.kind === 'net-done') as NetDoneMsg | undefined;
  };
  return { win, original, posted, parsers, uninstall, waitDone };
}

describe('wrapper de fetch (mundo MAIN)', () => {
  it('la página recibe el mismo Response y bytes idénticos (lectura completa)', async () => {
    const body = new TextEncoder().encode(fixture('claude-completion.sse'));
    let upstreamRes!: Response;
    const t = setup('claude.ai', async () => {
      upstreamRes = new Response(chunkedStream(body, 7), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      return upstreamRes;
    });
    const init = { method: 'POST', body: JSON.stringify({ prompt: 'Explicame B-tree', model: 'claude-sonnet-4-5' }) };
    const res = await t.win.fetch(CLAUDE_URL, init);
    expect(res).toBe(upstreamRes); // mismo objeto, no un Response reconstruido
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const pageBytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(pageBytes).equals(Buffer.from(body))).toBe(true);
    // El pedido saliente no se tocó
    expect(t.original).toHaveBeenCalledTimes(1);
    expect(t.original.mock.calls[0]![0]).toBe(CLAUDE_URL);
    expect(t.original.mock.calls[0]![1]).toBe(init);
    const done = await t.waitDone();
    expect(done).toBeDefined();
    // La copia vio exactamente el mismo texto (decodificación UTF-8 con cortes multibyte)
    expect(t.parsers[0]!.chunks.join('')).toBe(fixture('claude-completion.sse'));
  });

  it('bytes idénticos cuando la página lee con getReader() en streaming', async () => {
    const body = new TextEncoder().encode(fixture('chatgpt-conversation.sse'));
    const t = setup('chatgpt.com', async () => new Response(chunkedStream(body, 13), { status: 200 }));
    const res = await t.win.fetch('https://chatgpt.com/backend-api/f/conversation', {
      method: 'POST',
      body: JSON.stringify({ action: 'next', messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: ['hola'] } }] }),
    });
    const reader = res.body!.getReader();
    const got: number[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got.push(...value);
    }
    expect(Buffer.from(got).equals(Buffer.from(body))).toBe(true);
    expect(await t.waitDone()).toBeDefined();
  });

  it('URLs que no son de conversación: misma promesa, sin parser ni mensajes', async () => {
    const sentinel = Promise.resolve(new Response('x'));
    const t = setup('claude.ai', () => sentinel);
    expect(t.win.fetch('https://claude.ai/api/organizations/org-1/chat_conversations')).toBe(sentinel);
    // GET al endpoint de completion tampoco se observa
    expect(t.win.fetch(CLAUDE_URL)).toBe(sentinel);
    // Otro dominio con el mismo path
    expect(t.win.fetch('https://evil.example/api/organizations/o/chat_conversations/c/completion', { method: 'POST' })).toBe(sentinel);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.parsers).toHaveLength(0);
    expect(t.posted).toHaveLength(0);
  });

  it('en URLs de conversación también devuelve la misma promesa del fetch original', async () => {
    const sentinel = Promise.resolve(new Response('data: {}\n\n'));
    const t = setup('chatgpt.com', () => sentinel);
    expect(t.win.fetch('https://chatgpt.com/backend-api/conversation', { method: 'POST' })).toBe(sentinel);
    await t.waitDone();
  });

  it('errores de red se propagan igual y un parser que explota no rompe la página', async () => {
    const err = new TypeError('Failed to fetch');
    const t = setup('claude.ai', () => Promise.reject(err));
    await expect(t.win.fetch(CLAUDE_URL, { method: 'POST' })).rejects.toBe(err);

    const body = new TextEncoder().encode('data: x\n\n');
    const posted: BridgePayload[] = [];
    const win = { fetch: (async () => new Response(body)) as unknown as typeof fetch, location: { href: 'https://claude.ai/' } };
    installFetchWrapper(win, {
      site: 'claude.ai',
      post: (m) => void posted.push(m),
      createParser: () => ({
        push: () => {
          throw new Error('boom');
        },
        result: () => {
          throw new Error('boom');
        },
      }),
    });
    const res = await win.fetch(CLAUDE_URL, { method: 'POST' });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
  });

  it('net-start lleva prompt, regeneración y conversación; uninstall restaura el fetch', async () => {
    const t = setup('claude.ai', async () => new Response('data: {}\n\n'));
    const retryUrl = CLAUDE_URL.replace('/completion', '/retry_completion');
    await t.win.fetch(retryUrl, { method: 'POST', body: JSON.stringify({ prompt: '' }) });
    await t.waitDone();
    const start = t.posted.find((m) => m.kind === 'net-start') as NetStartMsg;
    expect(start.regenerated).toBe(true);
    expect(start.conversationId).toBe('0f3c9a1e-1111-2222-3333-444444444444');
    t.uninstall();
    expect(t.win.fetch).toBe(t.original);
  });

  it('describeRequest de chatgpt: variant = regenerar, prompt, modelo caro', () => {
    const d = describeRequest(
      'chatgpt.com',
      {
        action: 'variant',
        model: 'gpt-5-thinking',
        conversation_id: 'abc',
        messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: ['hola mundo'] } }],
      },
      false,
    );
    expect(d).toMatchObject({ regenerated: true, prompt: 'hola mundo', requestModel: 'gpt-5-thinking', conversationId: 'abc', expensiveMode: 'gpt-5-thinking' });
    const c = describeRequest('claude.ai', { prompt: 'p', attachments: [{ extracted_content: 'contenido del archivo', file_name: 'a.txt' }] }, false);
    expect(c.attachments).toHaveLength(1);
    expect(c.attachments![0]!.hash).toMatch(/^[0-9a-f]+$/);
  });
});
