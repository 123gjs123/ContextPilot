// Content script ISOLATED (document_start). Conecta ContentController con chrome.runtime/storage.
import { negotiateNonce } from '../bridge.js';
import { ContentController } from '../content/controller.js';
import { PENDING_KEY, type PendingHandoff } from '../handoff.js';
import type { HandoffResponse, ToBackground, ToContent } from '../messages.js';
import { siteForHost } from '../sites.js';

function send(msg: ToBackground): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    // contexto invalidado (extensión recargada): se ignora, la página sigue igual
  }
}

const site = siteForHost(location.hostname);
if (site) {
  // Gemini no tiene script MAIN: no se negocia nonce (el atributo quedaría huérfano en el DOM).
  const nonce = site.primary === 'net' ? negotiateNonce(document) : '';
  const ctl = new ContentController({
    doc: document,
    win: window,
    site,
    nonce,
    sendEvents: (events) => send({ type: 'cp:events', events }),
    sendStatus: (status) => send({ type: 'cp:tab-status', status }),
    sendFeedback: (id, sessionId, feedback) => send({ type: 'cp:feedback', id, sessionId, feedback }),
    requestHandoff: async (sessionId, content) => {
      try {
        return (await chrome.runtime.sendMessage({ type: 'cp:handoff', sessionId, content } satisfies ToBackground)) as HandoffResponse;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'error' };
      }
    },
    loadPending: async () => ((await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] as PendingHandoff | undefined) ?? null,
    savePending: async (p) => {
      if (p) await chrome.storage.local.set({ [PENDING_KEY]: p });
      else await chrome.storage.local.remove(PENDING_KEY);
    },
    navigate: (url) => location.assign(url),
  });
  // El puente se escucha ya (document_start); el DOM cuando está listo.
  if (nonce) ctl.listenBridge();
  const startDom = (): void => ctl.startDom();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startDom, { once: true });
  else startDom();

  chrome.runtime.onMessage.addListener((msg: ToContent, _sender, sendResponse) => {
    if (msg.type === 'cp:ping') sendResponse({ sessionId: ctl.currentSessionId, capture: ctl.captureMode });
    else ctl.handleRuntime(msg);
    return false;
  });
}
