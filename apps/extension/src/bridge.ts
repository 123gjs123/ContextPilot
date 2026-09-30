// Puente entre el mundo MAIN (wrapper de fetch) y el mundo ISOLATED (content script).
// Ambos scripts corren en document_start, antes que cualquier script de la página. El primero que
// corre genera un nonce aleatorio y lo deja en un atributo del <html>; el segundo lo lee y lo borra,
// así la página nunca lo ve en el DOM. Los mensajes viajan por window.postMessage con ese nonce.
// Limitación conocida: una vez que se postea el primer mensaje, un script de la página que escuche
// "message" podría ver el nonce; el contenido es el de la propia página y el daemon sólo recibe
// métricas, así que el peor caso es un evento falso (documentado en docs/reports/extension.md).
import type { NetSiteId } from './sites.js';

const ATTR = 'data-cp-bridge';
export const BRIDGE_TAG = 'contextpilot-bridge';

export function randomNonce(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Negociación simétrica: devuelve el mismo nonce en los dos mundos. */
export function negotiateNonce(doc: Document): string {
  const root = doc.documentElement;
  const existing = root.getAttribute(ATTR);
  if (existing) {
    root.removeAttribute(ATTR);
    return existing;
  }
  const n = randomNonce();
  root.setAttribute(ATTR, n);
  return n;
}

export interface NetStartMsg {
  kind: 'net-start';
  reqId: string;
  site: NetSiteId;
  ts: number;
  prompt?: string;
  regenerated?: boolean;
  requestModel?: string;
  expensiveMode?: string;
  conversationId?: string;
  attachments?: { hash: string; tokens: number }[];
}

export interface NetDoneMsg {
  kind: 'net-done';
  reqId: string;
  site: NetSiteId;
  ts: number;
  text: string;
  model?: string;
  done: boolean;
  messageId?: string;
  conversationId?: string;
  reasoningText?: string;
  error?: string;
}

export type BridgePayload = NetStartMsg | NetDoneMsg;
export type BridgeEnvelope = BridgePayload & { tag: typeof BRIDGE_TAG; nonce: string };

export function envelope(nonce: string, p: BridgePayload): BridgeEnvelope {
  return { ...p, tag: BRIDGE_TAG, nonce };
}

/** Valida origen, etiqueta y nonce de un MessageEvent. */
export function readBridge(ev: MessageEvent, win: Window, nonce: string): BridgePayload | null {
  if (ev.source !== win) return null;
  const d = ev.data as Partial<BridgeEnvelope> | null;
  if (!d || typeof d !== 'object' || d.tag !== BRIDGE_TAG || d.nonce !== nonce) return null;
  if (d.kind !== 'net-start' && d.kind !== 'net-done') return null;
  const { tag: _t, nonce: _n, ...rest } = d as BridgeEnvelope;
  return rest as BridgePayload;
}
