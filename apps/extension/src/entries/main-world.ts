// Script del mundo MAIN (document_start): envuelve window.fetch sólo en claude.ai y chatgpt.com.
// No tiene acceso a chrome.*; publica resultados al content script con window.postMessage + nonce.
import { createWebStreamParser } from '@contextpilot/core';
import { envelope, negotiateNonce } from '../bridge.js';
import { installFetchWrapper } from '../capture/fetchWrapper.js';
import { siteForHost, type NetSiteId } from '../sites.js';

(() => {
  try {
    const site = siteForHost(location.hostname);
    if (!site || site.primary !== 'net') return;
    const nonce = negotiateNonce(document);
    const origin = location.origin;
    installFetchWrapper(window, {
      site: site.id as NetSiteId,
      createParser: (s) => createWebStreamParser(s),
      // targetOrigin = el propio origen: el mensaje no sale a iframes de terceros.
      post: (msg) => window.postMessage(envelope(nonce, msg), origin),
    });
  } catch {
    // Nunca romper la página.
  }
})();
