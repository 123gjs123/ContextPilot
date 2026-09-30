// CP-038.2 (eventos desde la red), CP-040 (respaldo DOM y regeneración) sobre el controller ISOLATED.
import { createWebStreamParser, type TurnEvent } from '@contextpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope } from '../src/bridge.js';
import { installFetchWrapper } from '../src/capture/fetchWrapper.js';
import { ContentController } from '../src/content/controller.js';
import type { TabStatus } from '../src/messages.js';
import { SITES } from '../src/sites.js';
import { chunkedStream, dom, fixture, flush } from './helpers.js';

const CID = '0f3c9a1e-1111-2222-3333-444444444444';

function setup(url = `https://claude.ai/chat/${CID}`) {
  const d = dom(fixture('claude-page.html'), url);
  const events: TurnEvent[] = [];
  const statuses: TabStatus[] = [];
  const ctl = new ContentController({
    doc: d.doc,
    win: d.win,
    site: SITES['claude.ai'],
    nonce: 'nonce-1',
    sendEvents: (e) => events.push(...e),
    sendStatus: (s) => statuses.push(s),
    sendFeedback: () => undefined,
    requestHandoff: async () => ({ ok: false }),
    loadPending: async () => null,
    savePending: async () => undefined,
    navigate: () => undefined,
    fallbackGraceMs: 2000,
  });
  const turns = d.doc.querySelector('[data-testid="conversation-turns"]')!;
  const addExchange = (prompt: string, answer = '') => {
    const u = d.doc.createElement('div');
    u.innerHTML = `<div class="font-user-message" data-testid="user-message"><p>${prompt}</p></div>`;
    const a = d.doc.createElement('div');
    a.innerHTML = `<div data-is-streaming="true"><div class="font-claude-response"><p>${answer}</p></div></div>`;
    turns.append(u, a);
    return {
      p: a.querySelector('.font-claude-response p')!,
      finish: () => a.firstElementChild!.setAttribute('data-is-streaming', 'false'),
    };
  };
  return { ...d, ctl, events, statuses, addExchange };
}

describe('captura de red → TurnEvent', () => {
  it('fixture SSE real de claude.ai: wrapper + parser de core + controller', async () => {
    const t = setup();
    t.ctl.checkUrl();
    t.ctl.listenBridge();
    const body = new TextEncoder().encode(fixture('claude-completion.sse'));
    const expected = JSON.parse(fixture('claude-completion.expected.json'));
    const fakeWin = {
      fetch: (async () => new Response(chunkedStream(body, 11))) as unknown as typeof fetch,
      location: { href: `https://claude.ai/chat/${CID}` },
    };
    // Mismo transporte que en producción: postMessage con nonce hacia la ventana del content script.
    installFetchWrapper(fakeWin, {
      site: 'claude.ai',
      createParser: (s) => createWebStreamParser(s),
      post: (m) => t.win.dispatchEvent(new t.win.MessageEvent('message', { data: envelope('nonce-1', m), source: t.win })),
    });
    const res = await fakeWin.fetch(`https://claude.ai/api/organizations/o/chat_conversations/${CID}/completion`, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Dame un ejemplo en SQL' }),
    });
    await res.text();
    await vi.waitFor(() => expect(t.events).toHaveLength(1));
    const ev = t.events[0]!;
    expect(ev).toMatchObject({ sessionId: `claude.ai:${CID}`, model: expected.model, client: 'claude.ai', provider: 'anthropic', turn: 1 });
    expect(ev.tokens.output).toBeGreaterThan(20);
    expect(ev.tokens.estimated).toBe(true);
    // Un nonce equivocado se ignora
    t.win.dispatchEvent(
      new t.win.MessageEvent('message', { data: envelope('otro', { kind: 'net-done', reqId: 'x', site: 'claude.ai', ts: 1, text: 'x', done: true }), source: t.win }),
    );
    await flush();
    expect(t.events).toHaveLength(1);
  });

  it('input = conversación visible al empezar; regenerated por mismo prompt o clic en Reintentar', async () => {
    const t = setup();
    t.ctl.checkUrl();
    t.ctl.onNetStart({ kind: 'net-start', reqId: 'r1', site: 'claude.ai', ts: 1, prompt: 'Dame un ejemplo en SQL' });
    t.addExchange('Dame un ejemplo en SQL', 'CREATE INDEX ...').finish();
    await t.ctl.onNetDone({ kind: 'net-done', reqId: 'r1', site: 'claude.ai', ts: 2, text: 'CREATE INDEX idx ON t(c);', done: true, model: 'claude-opus-4-1' });
    expect(t.events[0]).toMatchObject({ turn: 2, model: 'claude-opus-4-1', contextWindow: 200_000 });
    expect(t.events[0]!.regenerated).toBeUndefined();
    expect(t.events[0]!.tokens.input).toBeGreaterThan(20); // incluye el turno previo del fixture

    // Mismo prompt reenviado → regeneración
    t.ctl.onNetStart({ kind: 'net-start', reqId: 'r2', site: 'claude.ai', ts: 3, prompt: 'Dame  un ejemplo en SQL ' });
    await t.ctl.onNetDone({ kind: 'net-done', reqId: 'r2', site: 'claude.ai', ts: 4, text: 'otra', done: true });
    expect(t.events[1]!.regenerated).toBe(true);

    // Clic en «Reintentar» (DOM) → regeneración aunque el prompt no venga en el body
    t.ctl.startDom();
    t.doc.querySelector<HTMLElement>('[data-testid="action-bar-retry"]')!.dispatchEvent(new t.win.MouseEvent('click', { bubbles: true }));
    t.ctl.onNetStart({ kind: 'net-start', reqId: 'r3', site: 'claude.ai', ts: 5 });
    await t.ctl.onNetDone({ kind: 'net-done', reqId: 'r3', site: 'claude.ai', ts: 6, text: 'tercera', done: true });
    expect(t.events[2]!.regenerated).toBe(true);
    t.ctl.stop();
  });

  it('adjuntos: SHA-256 del archivo, sólo hash + tokens', async () => {
    const t = setup();
    t.ctl.checkUrl();
    const f = new File(['contenido de prueba del adjunto'], 'notas.txt', { type: 'text/plain' });
    await t.ctl.hashFiles([f]);
    t.ctl.onNetStart({ kind: 'net-start', reqId: 'a', site: 'claude.ai', ts: 1, prompt: 'resumí el adjunto' });
    await t.ctl.onNetDone({ kind: 'net-done', reqId: 'a', site: 'claude.ai', ts: 2, text: 'ok', done: true });
    const att = t.events[0]!.attachments!;
    expect(att).toHaveLength(1);
    // sha256("contenido de prueba del adjunto")
    const { createHash } = await import('node:crypto');
    expect(att[0]!.hash).toBe(createHash('sha256').update('contenido de prueba del adjunto').digest('hex'));
    expect(JSON.stringify(t.events[0])).not.toContain('contenido de prueba');
  });
});

describe('respaldo DOM en claude.ai (CP-040)', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-09-30T12:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  async function tick(ms: number) {
    await flush();
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  }

  async function domTurn(t: ReturnType<typeof setup>, prompt: string, net: boolean) {
    const composer = t.doc.querySelector<HTMLElement>('.ProseMirror')!;
    composer.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (net) t.ctl.onNetStart({ kind: 'net-start', reqId: prompt, site: 'claude.ai', ts: Date.now(), prompt });
    const x = t.addExchange(prompt);
    await tick(200);
    x.p.textContent = `respuesta a ${prompt}`;
    await tick(300);
    x.finish();
    if (net) await t.ctl.onNetDone({ kind: 'net-done', reqId: prompt, site: 'claude.ai', ts: Date.now(), text: `respuesta a ${prompt}`, done: true });
    await tick(1600 + 2100); // quietud + gracia
  }

  it('sin captura de red la capa DOM emite; tras 2 turnos seguidos health = fallback-dom', async () => {
    const t = setup();
    t.ctl.startDom();
    await domTurn(t, 'primera pregunta', false);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ sessionId: `claude.ai:${CID}`, turn: 2, model: 'claude-sonnet-4.5' });
    expect(t.statuses.at(-1)!.capture).toBe('net');
    await domTurn(t, 'segunda pregunta', false);
    expect(t.events).toHaveLength(2);
    expect(t.statuses.at(-1)!.capture).toBe('fallback-dom');
    t.ctl.stop();
  });

  it('con captura de red no duplica: la capa DOM se abstiene', async () => {
    const t = setup();
    t.ctl.startDom();
    await domTurn(t, 'con red', true);
    expect(t.events).toHaveLength(1);
    await tick(5000);
    expect(t.events).toHaveLength(1);
    t.ctl.stop();
  });
});
