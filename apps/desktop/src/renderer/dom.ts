import type { RendererApi } from '../shared/types.js';

// Mini helper de DOM sin framework. Todo el texto entra por textContent (sin innerHTML con datos).

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((ev: any) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export type CpApi = RendererApi & { onOpenSession(cb: (id: string) => void): () => void };

export function cp(): CpApi {
  return (window as unknown as { cp: CpApi }).cp;
}

let toastTimer: number | undefined;
export function toast(message: string, bad = false): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = message;
  el.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.add('hidden'), 4000);
}
