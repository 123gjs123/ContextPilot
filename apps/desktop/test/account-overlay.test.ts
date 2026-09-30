// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { initialState, reduce } from '../src/shared/store.js';
import type { AppSnapshot } from '../src/shared/types.js';
import { accountRows, sessionRows, trayColor } from '../src/shared/view.js';
import { NOW, sess, sug } from './helpers.js';

// D-1 (banner de cuenta en tray/overlay) y D-16 (CP-046.2: «Ignorar» y «Posponer 15 min» del overlay).

function st(suggestions = [] as ReturnType<typeof sug>[]) {
  return reduce(initialState(), { type: 'hello', data: { version: '1', sessions: [sess()], suggestions, health: [] } });
}

const r10 = sug({ id: 'acc-1', ruleId: 'R10', sessionId: 'account:anthropic', severity: 'critical', title: 'A este ritmo llegás al límite a las 12:58', actions: [{ kind: 'show-detail', label: 'Ver proyección' }] });

describe('D-1: sugerencia de cuenta en el desktop', () => {
  it('va al banner de cuenta, no a una sesión; convive con la sugerencia de la sesión', () => {
    const s = st([sug(), r10]);
    expect(accountRows(s, NOW)).toEqual([expect.objectContaining({ provider: 'anthropic', suggestion: expect.objectContaining({ id: 'acc-1', ruleId: 'R10' }) })]);
    const rows = sessionRows(s, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.suggestion?.ruleId).toBe('R1');
  });
  it('colorea el tray aunque la sesión esté sana', () => {
    expect(trayColor(st([r10]), NOW)).toBe('red');
    expect(trayColor(st([{ ...r10, quiet: true }]), NOW)).toBe('green');
  });
});

describe('overlay (jsdom): acciones de la sugerencia', () => {
  it('Ignorar → dismissed, Posponer 15 min → snoozed, banner de cuenta visible', async () => {
    document.body.innerHTML = '<span id="dot"></span><section id="body"></section><span id="desktopStatus"></span><button id="btnDash"></button><button id="btnClose"></button>';
    const s = st([sug(), r10]);
    const snap: AppSnapshot = {
      connection: 'connected',
      sessions: sessionRows(s, NOW),
      account: accountRows(s, NOW),
      health: [],
      trayColor: 'red',
      desktopAdapter: { status: 'disabled', detail: 'apagado' },
    };
    const feedback = vi.fn(async () => ({ ok: true, message: 'ok' }));
    (window as any).cp = {
      getSnapshot: async () => snap,
      onSnapshot: () => () => undefined,
      onFocusSuggestion: () => () => undefined,
      feedback,
      runAction: vi.fn(async () => ({ ok: true, message: 'ok' })),
      openDashboard: vi.fn(),
      hideOverlay: vi.fn(),
    };
    (globalThis as any).CSS ??= { escape: (x: string) => x };
    await import('../src/renderer/overlay.js');
    await vi.waitFor(() => expect(document.body.dataset.ready).toBe('1'));
    const acc = document.querySelector('.account[data-provider="anthropic"]');
    expect(acc?.textContent).toContain('Cuenta Claude');
    expect(acc?.textContent).toContain('12:58');
    const sessionSug = document.querySelector('.session .sug[data-id="g1"]')!;
    const btn = (label: string) => [...sessionSug.querySelectorAll('button')].find((b) => b.textContent === label)!;
    btn('Ignorar').click();
    await vi.waitFor(() => expect(feedback).toHaveBeenCalledWith('g1', 'dismissed'));
    await new Promise((r) => setTimeout(r, 0));
    btn('Posponer 15 min').click();
    await vi.waitFor(() => expect(feedback).toHaveBeenCalledWith('g1', 'snoozed'));
  });
});
