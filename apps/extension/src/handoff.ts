// Traspaso web (CP-041, RF-HAN-02, RNF-12).
// 1) Se lee la conversación del DOM en el momento del clic, se redacta y se manda a POST /handoff
//    (en memoria; nunca se persiste el contenido de la conversación).
// 2) El resumen se copia al portapapeles (respaldo) y se guarda como "traspaso pendiente" efímero.
// 3) Se navega a la URL de chat nuevo; al cargar, el content script pega el resumen en el
//    compositor SIN enviarlo: nada de clics sintéticos, envío de formularios ni Enter sintético.
import { redact } from '@contextpilot/core';
import { conversationText, findComposer } from './page.js';
import type { SiteDef, SiteId } from './sites.js';

export const PENDING_KEY = 'cpPendingHandoff';
/** Un traspaso pendiente vence rápido: si no se pegó en 3 min, se descarta. */
export const PENDING_TTL_MS = 3 * 60_000;

export interface PendingHandoff {
  site: SiteId;
  summary: string;
  createdAt: number;
}

export function extractForHandoff(doc: Document, site: SiteDef): string {
  return redact(conversationText(doc, site));
}

/**
 * Inserta texto en el compositor con eventos compatibles con editores React/ProseMirror/Quill.
 * No envía: sólo foco + inserción + eventos input.
 */
export function pasteIntoComposer(doc: Document, el: HTMLElement, text: string): boolean {
  const win = doc.defaultView;
  if (!win) return false;
  el.focus();
  if (el instanceof win.HTMLTextAreaElement || el instanceof win.HTMLInputElement) {
    // Setter nativo: React ignora asignaciones directas a .value sin esto.
    const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const next = el.value ? `${el.value}\n\n${text}` : text;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    return true;
  }
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
    // Camino preferido: insertText pasa por el pipeline de beforeinput/input del editor.
    let ok = false;
    try {
      const sel = win.getSelection();
      if (sel) {
        const range = doc.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      ok = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, text) === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      // Respaldo: párrafos + InputEvent. Los editores re-sincronizan su modelo desde el DOM.
      const existing = (el.textContent ?? '').trim();
      if (!existing) el.textContent = '';
      for (const line of text.split('\n')) {
        const p = doc.createElement('p');
        if (line) p.textContent = line;
        else p.appendChild(doc.createElement('br'));
        el.appendChild(p);
      }
      const InputEv = (win as unknown as { InputEvent?: typeof InputEvent }).InputEvent;
      el.dispatchEvent(
        InputEv ? new InputEv('input', { bubbles: true, inputType: 'insertText', data: text }) : new win.Event('input', { bubbles: true }),
      );
    }
    return true;
  }
  return false;
}

/** Espera al compositor del chat nuevo (SPA) y pega. */
export function waitAndPaste(
  doc: Document,
  site: SiteDef,
  text: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const tryNow = (): boolean => {
      const el = findComposer(doc, site);
      if (!el) return false;
      resolve(pasteIntoComposer(doc, el, text));
      return true;
    };
    if (tryNow()) return;
    const MO = doc.defaultView?.MutationObserver ?? MutationObserver;
    const obs = new MO(() => {
      if (tryNow()) {
        obs.disconnect();
        clearTimeout(t);
      }
    });
    obs.observe(doc.documentElement, { childList: true, subtree: true });
    const t = setTimeout(() => {
      obs.disconnect();
      resolve(false);
    }, timeoutMs);
  });
}

export function isPendingValid(p: PendingHandoff | undefined | null, site: SiteId, now: number): p is PendingHandoff {
  return !!p && p.site === site && typeof p.summary === 'string' && now - p.createdAt < PENDING_TTL_MS;
}

/** Copia al portapapeles; clipboard API y, si falla (sin foco/gesto), execCommand('copy') sobre un textarea propio. */
export async function copyText(doc: Document, text: string): Promise<boolean> {
  try {
    await doc.defaultView?.navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand?.('copy') ?? false;
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
