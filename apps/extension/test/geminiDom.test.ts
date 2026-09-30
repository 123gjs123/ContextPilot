// CP-039: adaptador DOM de gemini.google.com sobre un DOM sintético con secuencias de mutaciones.
import { contextWindowFor, type TurnEvent } from '@contextpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomTurnWatcher, type DomTurn } from '../src/capture/domTurns.js';
import { ContentController } from '../src/content/controller.js';
import { SITES } from '../src/sites.js';
import { dom, fixture, flush } from './helpers.js';

const URL_CONV = 'https://gemini.google.com/app/9f1c2b3a4d5e6f70';
const site = SITES['gemini.google.com'];

function page() {
  const { doc, win } = dom(fixture('gemini-conversation.html'), URL_CONV);
  const scroller = doc.querySelector('infinite-scroller')!;
  const send = doc.querySelector<HTMLButtonElement>('button.send-button')!;
  const composer = doc.querySelector<HTMLElement>('.ql-editor')!;
  const startGenerating = () => {
    send.classList.add('stop');
    send.setAttribute('aria-label', 'Stop response');
  };
  const stopGenerating = () => {
    send.classList.remove('stop');
    send.setAttribute('aria-label', 'Send message');
  };
  const addTurn = (prompt: string) => {
    const c = doc.createElement('div');
    c.className = 'conversation-container';
    c.innerHTML = `<user-query><div class="query-text"><p class="query-text-line">${prompt}</p></div></user-query><model-response><div class="response-container"><message-content class="model-response-text"><div class="markdown"></div></message-content></div></model-response>`;
    scroller.appendChild(c);
    return c.querySelector<HTMLElement>('.markdown')!;
  };
  const pressEnter = () => composer.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return { doc, win, scroller, addTurn, startGenerating, stopGenerating, pressEnter };
}

async function tick(ms: number) {
  await flush();
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

describe('DomTurnWatcher en Gemini', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-09-30T12:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('emite un turno cuando la respuesta deja de mutar 1,5 s y no hay botón de detener', async () => {
    const p = page();
    const turns: DomTurn[] = [];
    const w = new DomTurnWatcher(p.doc, site, { onTurn: (t) => turns.push(t) });
    w.start();
    p.pressEnter();
    const md = p.addTurn('Dame un ejemplo en SQL');
    p.startGenerating();
    for (const chunk of ['Claro, ', 'acá tenés ', 'un ejemplo: ', 'CREATE INDEX ...']) {
      md.appendChild(p.doc.createTextNode(chunk));
      await tick(500); // streaming: mutaciones cada 500 ms
    }
    expect(turns).toHaveLength(0);
    // Pausa larga mientras sigue el botón de detener (p. ej. "pensando"): no emite
    await tick(4000);
    expect(turns).toHaveLength(0);
    p.stopGenerating();
    await tick(1499);
    expect(turns).toHaveLength(0);
    await tick(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      answerText: 'Claro, acá tenés un ejemplo: CREATE INDEX ...',
      promptText: 'Dame un ejemplo en SQL',
      turn: 2,
    });
    expect(turns[0]!.priorText).toContain('¿Qué es un índice B-tree?');
    expect(turns[0]!.priorText).toContain('Dame un ejemplo en SQL');
    // No re-emite sin cambios
    await tick(5000);
    expect(turns).toHaveLength(1);
    w.stop();
  });

  it('la carga del historial (sin envío del usuario) no genera turnos', async () => {
    const p = page();
    const turns: DomTurn[] = [];
    const w = new DomTurnWatcher(p.doc, site, { onTurn: (t) => turns.push(t) });
    w.start();
    const md = p.addTurn('pregunta vieja');
    md.textContent = 'respuesta vieja completa';
    await tick(3000);
    expect(turns).toHaveLength(0);
    w.stop();
  });

  it('el botón de detener arma el watcher aunque no se vea el Enter', async () => {
    const p = page();
    const turns: DomTurn[] = [];
    const w = new DomTurnWatcher(p.doc, site, { onTurn: (t) => turns.push(t) });
    w.start();
    p.startGenerating();
    const md = p.addTurn('otra');
    await tick(100);
    md.textContent = 'respuesta';
    await tick(200);
    p.stopGenerating();
    await tick(1600);
    expect(turns).toHaveLength(1);
    w.stop();
  });

  it('health error si no aparece el contenedor en 10 s', async () => {
    const { doc } = dom('<html><body><div>cargando</div></body></html>', URL_CONV);
    const health: string[] = [];
    const w = new DomTurnWatcher(doc, site, { onTurn: () => undefined, onHealth: (s) => health.push(s) });
    w.start();
    await tick(9999);
    expect(health).toEqual([]);
    await tick(1);
    expect(health).toEqual(['error']);
    w.stop();
  });

  it('ContentController emite TurnEvent de Gemini (sesión, modelo, modo caro)', async () => {
    const p = page();
    const events: TurnEvent[] = [];
    const statuses: unknown[] = [];
    const ctl = new ContentController({
      doc: p.doc,
      win: p.win,
      site,
      nonce: '',
      sendEvents: (e) => events.push(...e),
      sendStatus: (s) => statuses.push(s),
      sendFeedback: () => undefined,
      requestHandoff: async () => ({ ok: false }),
      loadPending: async () => null,
      savePending: async () => undefined,
      navigate: () => undefined,
    });
    ctl.startDom();
    expect(ctl.currentSessionId).toBe('gemini.google.com:9f1c2b3a4d5e6f70');
    p.pressEnter();
    const md = p.addTurn('Explicame los índices GIN de Postgres con un ejemplo');
    p.startGenerating();
    md.textContent = 'Los índices GIN sirven para búsquedas en arrays y texto completo.';
    await tick(300);
    p.stopGenerating();
    await tick(1600);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev).toMatchObject({
      source: 'web',
      provider: 'google',
      client: 'gemini.google.com',
      sessionId: 'gemini.google.com:9f1c2b3a4d5e6f70',
      turn: 2,
      model: 'gemini-2.5-pro',
      contextWindow: contextWindowFor('gemini-2.5-pro', 'google'),
      expensiveMode: 'gemini-2.5-pro',
    });
    expect(ev.tokens.estimated).toBe(true);
    expect(ev.tokens.input).toBeGreaterThan(20);
    expect(ev.contextSize).toBe(ev.tokens.input + ev.tokens.output);
    expect(statuses[0]).toMatchObject({ site: 'gemini.google.com', capture: 'dom' });
    ctl.stop();
  });
});
