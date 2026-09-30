// CP-048: banner en Shadow DOM encima del compositor, ≤ 2 botones, nunca tapa ni envía.
import type { Suggestion } from '@contextpilot/core';
import { describe, expect, it, vi } from 'vitest';
import { Banner, BANNER_TAG } from '../src/ui/banner.js';
import { SITES, type SiteId } from '../src/sites.js';
import { dom, fixture } from './helpers.js';

const sug = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: 'sug-1',
  ruleId: 'W1',
  sessionId: 'claude.ai:abc',
  severity: 'warn',
  title: 'Conversación de ≈92k tokens: chat nuevo con resumen',
  detail: 'Lleva 41 turnos.',
  estimatedSavingTokens: 89_000,
  actions: [{ kind: 'handoff', label: 'Generar resumen' }],
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ...over,
});

const PAGES: [SiteId, string, string][] = [
  ['claude.ai', 'claude-page.html', 'https://claude.ai/chat/abc'],
  ['chatgpt.com', 'chatgpt-page.html', 'https://chatgpt.com/c/68db1c2e-0000'],
  ['gemini.google.com', 'gemini-conversation.html', 'https://gemini.google.com/app/9f1c2b3a4d5e'],
];

describe.each(PAGES)('banner en %s', (siteId, file, url) => {
  const site = SITES[siteId];

  function setup() {
    const { doc, win } = dom(fixture(file), url);
    const composer = doc.querySelector<HTMLElement>(site.selectors.composer.join(','))!;
    const handlers = { onAction: vi.fn(), onDismiss: vi.fn() };
    const banner = new Banner(doc, site, handlers);
    const submits = vi.fn();
    doc.addEventListener('submit', submits, true);
    const keys = vi.fn();
    doc.addEventListener('keydown', keys, true);
    return { doc, win, composer, handlers, banner, submits, keys };
  }

  it('se inserta justo antes del contenedor del compositor, fuera de él y en flujo normal', () => {
    const t = setup();
    const before = t.composer.innerHTML;
    expect(t.banner.show(sug())).toBe(true);
    const host = t.doc.querySelector(BANNER_TAG)!;
    expect(host).toBeTruthy();
    expect(host.shadowRoot).toBeTruthy();
    // Hermano previo del contenedor: queda arriba del cuadro de texto, sin superponerse
    const container = host.nextElementSibling!;
    expect(container.contains(t.composer)).toBe(true);
    expect(host.contains(t.composer)).toBe(false);
    expect(t.composer.contains(host)).toBe(false);
    expect(host.compareDocumentPosition(t.composer) & 4).toBeTruthy(); // compositor DESPUÉS del banner
    // Sin posicionamiento que pueda superponerse
    const css = host.shadowRoot!.querySelector('style')!.textContent!;
    expect(css).toMatch(/:host\s*\{[^}]*position:\s*static/);
    expect(css).not.toMatch(/position:\s*(absolute|fixed)/);
    // El compositor no cambió
    expect(t.composer.innerHTML).toBe(before);
  });

  it('una línea con ≤ 2 botones: «Generar resumen» e «Ignorar»', () => {
    const t = setup();
    t.banner.show(sug());
    const root = t.doc.querySelector(BANNER_TAG)!.shadowRoot!;
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Generar resumen', 'Ignorar']);
    expect(buttons.every((b) => b.type === 'button')).toBe(true); // nunca type=submit
    const msg = root.querySelector('.msg')!;
    expect(msg.textContent).toContain('≈92k');
    expect(msg.textContent).toContain('ahorro ≈89k');
    const css = root.querySelector('style')!.textContent!;
    expect(css).toMatch(/\.msg\s*\{[^}]*white-space:\s*nowrap/);
  });

  it('botones: acción → handler; Ignorar → dismissed y oculta; nunca envía', () => {
    const t = setup();
    t.banner.show(sug());
    const root = () => t.doc.querySelector(BANNER_TAG)?.shadowRoot;
    root()!.querySelector<HTMLButtonElement>('[data-cp="primary"]')!.dispatchEvent(new t.win.MouseEvent('click', { bubbles: true }));
    expect(t.handlers.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'sug-1' }), expect.objectContaining({ kind: 'handoff' }));
    root()!.querySelector<HTMLButtonElement>('[data-cp="dismiss"]')!.dispatchEvent(new t.win.MouseEvent('click', { bubbles: true }));
    expect(t.handlers.onDismiss).toHaveBeenCalledTimes(1);
    expect(t.doc.querySelector(BANNER_TAG)).toBeNull();
    // Ignorada: la misma sugerencia no vuelve a mostrarse
    expect(t.banner.show(sug())).toBe(false);
    expect(t.submits).not.toHaveBeenCalled();
    expect(t.keys).not.toHaveBeenCalled();
  });

  it('sugerencias quiet o vencidas no se muestran; una nueva reemplaza a la anterior', () => {
    const t = setup();
    expect(t.banner.show(sug({ quiet: true }))).toBe(false);
    expect(t.banner.show(sug({ id: 'old', expiresAt: '2000-01-01T00:00:00Z' }))).toBe(false);
    expect(t.doc.querySelector(BANNER_TAG)).toBeNull();
    t.banner.show(sug({ id: 'a' }));
    t.banner.show(sug({ id: 'b', title: 'Regeneraste 3 veces', actions: [{ kind: 'copy', label: 'Copiar plantilla', payload: 'x' }] }));
    expect(t.doc.querySelectorAll(BANNER_TAG)).toHaveLength(1);
    const labels = [...t.doc.querySelector(BANNER_TAG)!.shadowRoot!.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Copiar plantilla', 'Ignorar']);
  });

  it('se re-inserta si el sitio re-renderiza el compositor', () => {
    const t = setup();
    t.banner.show(sug());
    t.doc.querySelector(BANNER_TAG)!.remove();
    t.banner.ensureAttached();
    expect(t.doc.querySelectorAll(BANNER_TAG)).toHaveLength(1);
  });
});
