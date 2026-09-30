// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { envelope, negotiateNonce, readBridge } from '../src/bridge.js';

describe('puente MAIN ↔ ISOLATED', () => {
  it('los dos mundos obtienen el mismo nonce y no queda en el DOM', () => {
    const a = negotiateNonce(document);
    expect(document.documentElement.getAttribute('data-cp-bridge')).toBe(a);
    const b = negotiateNonce(document);
    expect(b).toBe(a);
    expect(document.documentElement.hasAttribute('data-cp-bridge')).toBe(false);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rechaza nonce incorrecto, otro origen de ventana o payload ajeno', () => {
    const nonce = 'n'.repeat(32);
    const msg = envelope(nonce, { kind: 'net-start', reqId: '1', site: 'claude.ai', ts: 1 });
    const ok = new MessageEvent('message', { data: msg, source: window });
    expect(readBridge(ok, window, nonce)).toMatchObject({ kind: 'net-start', reqId: '1' });
    expect(readBridge(ok, window, 'otro')).toBeNull();
    expect(readBridge(new MessageEvent('message', { data: msg, source: null }), window, nonce)).toBeNull();
    expect(readBridge(new MessageEvent('message', { data: { ...msg, kind: 'otra' }, source: window }), window, nonce)).toBeNull();
    expect(readBridge(new MessageEvent('message', { data: 'texto', source: window }), window, nonce)).toBeNull();
  });
});
