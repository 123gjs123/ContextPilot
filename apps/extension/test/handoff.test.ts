// CP-041 / CP-058: el traspaso se pega en el compositor del chat nuevo SIN disparar envío.
import type { Suggestion } from '@contextpilot/core';
import { describe, expect, it, vi } from 'vitest';
import { ContentController } from '../src/content/controller.js';
import { extractForHandoff, pasteIntoComposer, type PendingHandoff } from '../src/handoff.js';
import { SITES, type SiteId } from '../src/sites.js';
import { dom, fixture, flush } from './helpers.js';

const SUMMARY = 'Resumen de traspaso:\n- Objetivo: índices en Postgres\n- Decisión: B-tree por email';

/** Espía todo lo que podría enviar el mensaje. */
function guard(doc: Document, win: Window) {
  const w = win as unknown as typeof globalThis & Window;
  const spies = {
    submitEvent: vi.fn(),
    enter: vi.fn(),
    sendClick: vi.fn(),
    formSubmit: vi.spyOn(w.HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined),
    requestSubmit: vi.spyOn(w.HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => undefined),
    elementClick: vi.spyOn(w.HTMLElement.prototype, 'click'),
  };
  doc.addEventListener('submit', spies.submitEvent, true);
  doc.addEventListener(
    'keydown',
    (e) => {
      if ((e as KeyboardEvent).key === 'Enter') spies.enter();
    },
    true,
  );
  doc.addEventListener(
    'click',
    (e) => {
      const t = e.target as Element;
      if (t.closest?.('button[aria-label="Send message"], [data-testid="send-button"], button.send-button, button[type="submit"]')) spies.sendClick();
    },
    true,
  );
  return {
    ...spies,
    expectNothingSent() {
      expect(spies.submitEvent).not.toHaveBeenCalled();
      expect(spies.enter).not.toHaveBeenCalled();
      expect(spies.sendClick).not.toHaveBeenCalled();
      expect(spies.formSubmit).not.toHaveBeenCalled();
      expect(spies.requestSubmit).not.toHaveBeenCalled();
      expect(spies.elementClick).not.toHaveBeenCalled();
    },
  };
}

const CASES: [SiteId, string, string][] = [
  ['claude.ai', 'claude-page.html', 'https://claude.ai/new'],
  ['chatgpt.com', 'chatgpt-page.html', 'https://chatgpt.com/'],
  ['gemini.google.com', 'gemini-conversation.html', 'https://gemini.google.com/app'],
];

describe.each(CASES)('pegado de traspaso en %s', (siteId, file, url) => {
  it('inserta el texto en el compositor contenteditable con evento input y no envía', () => {
    const { doc, win } = dom(fixture(file), url);
    const g = guard(doc, win);
    const site = SITES[siteId];
    const composer = doc.querySelector<HTMLElement>(site.selectors.composer.join(','))!;
    const inputs = vi.fn();
    composer.addEventListener('input', inputs);
    expect(pasteIntoComposer(doc, composer, SUMMARY)).toBe(true);
    expect(composer.textContent).toContain('Objetivo: índices en Postgres');
    expect(inputs).toHaveBeenCalled();
    g.expectNothingSent();
  });
});

describe('pegado en textarea (React)', () => {
  it('usa el setter nativo + input/change y no envía', () => {
    const { doc, win } = dom('<form><textarea id="prompt-textarea"></textarea><button type="submit" data-testid="send-button">↑</button></form>', 'https://chatgpt.com/');
    const g = guard(doc, win);
    const ta = doc.querySelector('textarea')!;
    const events: string[] = [];
    ta.addEventListener('input', () => events.push('input'));
    ta.addEventListener('change', () => events.push('change'));
    expect(pasteIntoComposer(doc, ta, SUMMARY)).toBe(true);
    expect(ta.value).toBe(SUMMARY);
    expect(events).toEqual(['input', 'change']);
    g.expectNothingSent();
  });
});

describe('flujo completo de traspaso (controller)', () => {
  it('extrae y redacta el DOM, pide /handoff, copia, guarda pendiente y navega; en el chat nuevo pega sin enviar', async () => {
    const site = SITES['claude.ai'];
    const conv = dom(fixture('claude-page.html'), 'https://claude.ai/chat/0f3c9a1e-1111-2222');
    let pending: PendingHandoff | null = null;
    const requestHandoff = vi.fn(async () => ({ ok: true, summary: SUMMARY }));
    const navigate = vi.fn();
    const feedback = vi.fn();
    Object.defineProperty(conv.win.navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    const deps = (d: { doc: Document; win: Window }) => ({
      doc: d.doc,
      win: d.win,
      site,
      nonce: 'x',
      sendEvents: () => undefined,
      sendStatus: () => undefined,
      sendFeedback: feedback,
      requestHandoff,
      loadPending: async () => pending,
      savePending: async (p: PendingHandoff | null) => void (pending = p),
      navigate,
    });
    const ctl = new ContentController(deps(conv));
    ctl.checkUrl();
    const s: Suggestion = {
      id: 's1',
      ruleId: 'W1',
      sessionId: 'claude.ai:0f3c9a1e-1111-2222',
      severity: 'warn',
      title: 't',
      detail: 'd',
      actions: [{ kind: 'handoff', label: 'Generar resumen' }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const g1 = guard(conv.doc, conv.win);
    await ctl.startHandoff(s);
    const [sid, content] = requestHandoff.mock.calls[0] as unknown as [string, string];
    expect(sid).toBe('claude.ai:0f3c9a1e-1111-2222');
    expect(content).toContain('Usuario: Necesito ayuda con índices');
    expect(content).toContain('Asistente: Claro. Un índice B-tree');
    expect(content).not.toContain('sk-ant-api03-AAAA'); // redactado antes de salir
    expect(content).toContain('[REDACTED:anthropic-key]');
    expect(conv.win.navigator.clipboard.writeText).toHaveBeenCalledWith(SUMMARY);
    expect(pending).toMatchObject({ site: 'claude.ai', summary: SUMMARY });
    expect(feedback).toHaveBeenCalledWith('s1', s.sessionId, 'accepted');
    expect(navigate).toHaveBeenCalledWith('https://claude.ai/new');
    g1.expectNothingSent();
    g1.elementClick.mockRestore();

    // Chat nuevo: el compositor aparece más tarde (SPA)
    const fresh = dom('<html><body><main></main></body></html>', 'https://claude.ai/new');
    const g2 = guard(fresh.doc, fresh.win);
    const ctl2 = new ContentController(deps(fresh));
    const done = ctl2.resumeHandoff();
    await flush();
    const fs = fresh.doc.createElement('fieldset');
    fs.innerHTML = '<div contenteditable="true" class="ProseMirror"><p><br></p></div><button aria-label="Send message" type="button">↑</button>';
    fresh.doc.querySelector('main')!.appendChild(fs);
    expect(await done).toBe(true);
    expect(fs.querySelector('.ProseMirror')!.textContent).toContain('Decisión: B-tree por email');
    expect(pending).toBeNull(); // se consume una sola vez
    g2.expectNothingSent();
    g2.elementClick.mockRestore();
  });

  it('extractForHandoff ordena Usuario/Asistente según el documento', () => {
    const { doc } = dom(fixture('gemini-conversation.html'), 'https://gemini.google.com/app/abc123');
    const text = extractForHandoff(doc, SITES['gemini.google.com']);
    expect(text.indexOf('Usuario:')).toBeLessThan(text.indexOf('Asistente:'));
  });
});
