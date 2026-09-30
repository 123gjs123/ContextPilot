// Wrapper de window.fetch para el mundo MAIN (CP-038, RNF-12).
// Garantías:
//  - La página recibe EXACTAMENTE la misma promesa y el mismo objeto Response que devolvió el fetch
//    original (no se construye un Response nuevo). La copia para parsear sale de res.clone(), que
//    hace tee del body internamente: los bytes que lee la página no cambian.
//  - El pedido saliente no se toca: se llama al fetch original con los mismos argumentos.
//  - Cualquier error propio se traga: nunca rompe la página.
//  - URLs que no son de conversación pasan sin ningún trabajo extra (misma promesa).
import { hash, estimateTokens } from '@contextpilot/core';
import type { BridgePayload, NetStartMsg } from '../bridge.js';
import { matchNetRequest, SITES, type NetSiteId } from '../sites.js';

/** Contrato del parser de core (packages/core/src/parsers/web.ts). */
export interface WebStreamParser {
  push(chunk: string): void;
  result(): { text: string; model?: string; done: boolean; messageId?: string; conversationId?: string; reasoningText?: string };
}

export interface FetchWrapperDeps {
  site: NetSiteId;
  post(msg: BridgePayload): void;
  createParser(site: NetSiteId): WebStreamParser;
  now?: () => number;
}

interface FetchHost {
  fetch: typeof fetch;
  location: { href: string };
}

let seq = 0;

export function installFetchWrapper(win: FetchHost, deps: FetchWrapperDeps): () => void {
  const original = win.fetch;
  const now = deps.now ?? Date.now;

  const wrapped = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    // Primero y siempre: el pedido real, sin tocar argumentos.
    const resP = original.apply(this ?? win, args) as Promise<Response>;
    let match: ReturnType<typeof classify> = null;
    try {
      match = classify(win, deps.site, args[0], args[1]);
    } catch {
      match = null;
    }
    if (!match) return resP;
    const reqId = `${now().toString(36)}-${(++seq).toString(36)}`;
    // La reacción se registra ANTES de devolver la promesa: corre antes que la de la página, así
    // clone() ocurre antes de que la página bloquee el body con getReader().
    const copyP = resP.then(
      (res) => {
        try {
          return res.ok && res.body ? res.clone() : null;
        } catch {
          return null;
        }
      },
      () => null,
    );
    void observe(copyP, match, reqId, args[0], args[1], deps, now).catch(() => undefined);
    return resP;
  };
  // Que el wrapper se parezca al nativo para detecciones ingenuas.
  try {
    Object.defineProperty(wrapped, 'name', { value: 'fetch' });
    Object.defineProperty(wrapped, 'toString', { value: () => Function.prototype.toString.call(original) });
  } catch {
    /* sin efecto */
  }
  win.fetch = wrapped as typeof fetch;
  return () => {
    if (win.fetch === (wrapped as typeof fetch)) win.fetch = original;
  };
}

function classify(win: FetchHost, site: NetSiteId, input: RequestInfo | URL, init?: RequestInit) {
  let url: URL;
  let method = 'GET';
  if (typeof input === 'string') url = new URL(input, win.location.href);
  else if (input instanceof URL) url = input;
  else if (input && typeof (input as Request).url === 'string') {
    url = new URL((input as Request).url, win.location.href);
    method = (input as Request).method || 'GET';
  } else return null;
  if (init?.method) method = init.method;
  return matchNetRequest(site, method, url);
}

async function readRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  try {
    if (typeof init?.body === 'string') return JSON.parse(init.body);
    if (!init?.body && typeof Request !== 'undefined' && input instanceof Request && input.body) {
      // clone(): no consume el body que va a mandar el fetch original.
      return JSON.parse(await input.clone().text());
    }
  } catch {
    /* body no JSON */
  }
  return undefined;
}

/** Lee del body del pedido lo que ayuda a construir el evento (prompt, regenerar, modelo, adjuntos). */
export function describeRequest(site: NetSiteId, body: unknown, retry: boolean): Omit<NetStartMsg, 'kind' | 'reqId' | 'site' | 'ts'> {
  const out: Omit<NetStartMsg, 'kind' | 'reqId' | 'site' | 'ts'> = {};
  if (retry) out.regenerated = true;
  if (!body || typeof body !== 'object') return out;
  const b = body as Record<string, unknown>;
  if (site === 'claude.ai') {
    if (typeof b.prompt === 'string') out.prompt = b.prompt;
    if (typeof b.model === 'string') out.requestModel = b.model;
    if (typeof b.paprika_mode === 'string' && b.paprika_mode) out.expensiveMode = 'extended-thinking';
    if (Array.isArray(b.attachments)) {
      out.attachments = b.attachments
        .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>).extracted_content : undefined))
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
        .map((c) => ({ hash: hash(c), tokens: estimateTokens(c, 'anthropic') }));
      if (!out.attachments.length) delete out.attachments;
    }
  } else {
    if (b.action === 'variant') out.regenerated = true;
    if (typeof b.model === 'string') out.requestModel = b.model;
    if (typeof b.conversation_id === 'string') out.conversationId = b.conversation_id;
    const hints = Array.isArray(b.system_hints) ? (b.system_hints as unknown[]) : [];
    if (hints.includes('research')) out.expensiveMode = 'deep-research';
    else if (out.requestModel && SITES['chatgpt.com'].expensiveModelRe.test(out.requestModel)) out.expensiveMode = out.requestModel;
    const msgs = Array.isArray(b.messages) ? (b.messages as Record<string, unknown>[]) : [];
    const last = [...msgs].reverse().find((m) => (m?.author as Record<string, unknown> | undefined)?.role === 'user') ?? msgs.at(-1);
    const parts = (last?.content as Record<string, unknown> | undefined)?.parts;
    if (Array.isArray(parts)) {
      const text = parts.filter((p): p is string => typeof p === 'string').join('\n');
      if (text) out.prompt = text;
    }
  }
  return out;
}

async function observe(
  copyP: Promise<Response | null>,
  match: NonNullable<ReturnType<typeof matchNetRequest>>,
  reqId: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deps: FetchWrapperDeps,
  now: () => number,
): Promise<void> {
  const body = await readRequestBody(input, init);
  const desc = describeRequest(deps.site, body, match.retry);
  if (match.conversationId && !desc.conversationId) desc.conversationId = match.conversationId;
  safePost(deps, { kind: 'net-start', reqId, site: deps.site, ts: now(), ...desc });

  // null: error de red, respuesta no-ok o body no clonable (el error lo maneja la página)
  const copy = await copyP;
  if (!copy?.body) return;
  const parser = deps.createParser(deps.site);
  const reader = copy.body!.getReader();
  const decoder = new TextDecoder();
  let error: string | undefined;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      try {
        parser.push(decoder.decode(value, { stream: true }));
      } catch {
        /* chunk no parseable: se sigue */
      }
    }
    const tail = decoder.decode();
    if (tail) parser.push(tail);
  } catch (e) {
    // el stream se cortó (p. ej. el usuario detuvo la respuesta): se reporta lo parcial
    error = e instanceof Error ? e.name : 'stream-error';
  }
  let r: ReturnType<WebStreamParser['result']>;
  try {
    r = parser.result();
  } catch {
    return;
  }
  safePost(deps, {
    kind: 'net-done',
    reqId,
    site: deps.site,
    ts: now(),
    text: r.text,
    model: r.model ?? desc.requestModel,
    done: r.done,
    messageId: r.messageId,
    conversationId: r.conversationId,
    reasoningText: r.reasoningText,
    error,
  });
}

function safePost(deps: FetchWrapperDeps, msg: BridgePayload): void {
  try {
    deps.post(msg);
  } catch {
    /* nunca romper la página */
  }
}
