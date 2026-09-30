// Lectura del DOM de la conversación (sin modificarlo). Usa sólo los selectores de sites.ts.
import { isVisible, queryAllFirst, queryFirst, type SiteDef } from './sites.js';

export interface PageMessage {
  role: 'user' | 'assistant';
  el: HTMLElement;
  text: string;
}

function textOf(el: Element): string {
  // innerText respeta saltos visibles; jsdom no lo implementa → textContent.
  const t = (el as HTMLElement).innerText;
  return (typeof t === 'string' && t.length ? t : el.textContent ?? '').trim();
}

/** Quita elementos anidados dentro de otros del mismo conjunto (selectores que se superponen). */
function outermost(els: HTMLElement[]): HTMLElement[] {
  return els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
}

/** Mensajes visibles en orden de documento. */
export function readMessages(doc: Document, site: SiteDef): PageMessage[] {
  const users = outermost(queryAllFirst(doc, site.selectors.userMessage));
  const assistants = outermost(queryAllFirst(doc, site.selectors.assistantMessage));
  const all: PageMessage[] = [
    ...users.map((el) => ({ role: 'user' as const, el, text: '' })),
    ...assistants.map((el) => ({ role: 'assistant' as const, el, text: '' })),
  ];
  all.sort((a, b) => {
    if (a.el === b.el) return 0;
    const pos = a.el.compareDocumentPosition(b.el);
    return pos & 4 /* FOLLOWING */ ? -1 : 1;
  });
  for (const m of all) m.text = textOf(m.el);
  return all;
}

export function userMessageCount(doc: Document, site: SiteDef): number {
  return outermost(queryAllFirst(doc, site.selectors.userMessage)).length;
}

export function lastAssistant(doc: Document, site: SiteDef): HTMLElement | null {
  const a = outermost(queryAllFirst(doc, site.selectors.assistantMessage));
  return a.at(-1) ?? null;
}

export function messageText(el: Element): string {
  return textOf(el);
}

/** Texto de la conversación para traspaso (se redacta en el llamador). */
export function conversationText(doc: Document, site: SiteDef): string {
  return readMessages(doc, site)
    .filter((m) => m.text)
    .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.text}`)
    .join('\n\n');
}

export function isGenerating(doc: Document, site: SiteDef): boolean {
  const stop = queryFirst(doc, site.selectors.stopButton);
  if (stop && isVisible(stop)) return true;
  const busy = queryFirst(doc, site.selectors.busy);
  return !!busy && isVisible(busy);
}

export function findComposer(doc: Document, site: SiteDef): HTMLElement | null {
  return queryFirst<HTMLElement>(doc, site.selectors.composer);
}

export function findComposerContainer(doc: Document, site: SiteDef, composer: HTMLElement): HTMLElement {
  for (const s of site.selectors.composerContainer) {
    try {
      const c = composer.closest<HTMLElement>(s);
      if (c && c !== doc.body) return c;
    } catch {
      /* siguiente */
    }
  }
  return composer.parentElement && composer.parentElement !== doc.body ? composer.parentElement : composer;
}

export function currentModel(doc: Document, site: SiteDef): string | undefined {
  const el = queryFirst(doc, site.selectors.modelLabel);
  const label = el ? textOf(el) : '';
  return label ? site.normalizeModelLabel(label.split('\n')[0]!) : undefined;
}

export function detectExpensiveMode(doc: Document, site: SiteDef, model?: string): string | undefined {
  const el = queryFirst(doc, site.selectors.expensiveMode);
  if (el) return (el.getAttribute('aria-label') || textOf(el) || 'modo-caro').slice(0, 40);
  if (model && site.expensiveModelRe.test(model)) return model;
  return undefined;
}
