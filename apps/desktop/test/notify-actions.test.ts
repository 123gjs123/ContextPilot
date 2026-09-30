import { describe, expect, it } from 'vitest';
import { handoffClipboardText, planAction } from '../src/shared/actions.js';
import { NotificationFilter, notificationContent } from '../src/shared/notify.js';
import { NOW, sug } from './helpers.js';

describe('notificaciones (CP-047)', () => {
  it('sólo critical notifica; warn/info nunca', () => {
    const f = new NotificationFilter();
    expect(f.shouldNotify(sug({ id: 'i', severity: 'info' }), NOW)).toBe(false);
    expect(f.shouldNotify(sug({ id: 'w', severity: 'warn' }), NOW)).toBe(false);
    expect(f.shouldNotify(sug({ id: 'c', severity: 'critical' }), NOW)).toBe(true);
  });

  it('dedupe por id', () => {
    const f = new NotificationFilter();
    expect(f.shouldNotify(sug({ severity: 'critical' }), NOW)).toBe(true);
    expect(f.shouldNotify(sug({ severity: 'critical' }), NOW)).toBe(false);
  });

  it('quiet y vencidas no notifican', () => {
    const f = new NotificationFilter();
    expect(f.shouldNotify(sug({ id: 'q', severity: 'critical', quiet: true }), NOW)).toBe(false);
    expect(f.shouldNotify(sug({ id: 'e', severity: 'critical', expiresAt: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
  });

  it('memoria acotada', () => {
    const f = new NotificationFilter(2);
    for (const id of ['a', 'b', 'c']) f.shouldNotify(sug({ id, severity: 'critical' }), NOW);
    expect(f.shouldNotify(sug({ id: 'a', severity: 'critical' }), NOW)).toBe(true);
  });

  it('contenido recortado', () => {
    const c = notificationContent({ title: 'Loop', detail: 'x'.repeat(500) });
    expect(c.title).toBe('ContextPilot · Loop');
    expect(c.body.length).toBe(200);
  });
});

describe('acciones (CP-046.2/.3)', () => {
  it('copy copia payload y marca accepted', () => {
    const p = planAction(sug(), 0, 'claude-code');
    expect(p).toMatchObject({ kind: 'copy', text: '/compact', feedback: 'accepted' });
  });

  it('copy sin payload es error; índice inválido es error', () => {
    expect(planAction(sug({ actions: [{ kind: 'copy', label: 'x' }] }), 0, 'claude-code').kind).toBe('error');
    expect(planAction(sug(), 5, 'claude-code').kind).toBe('error');
  });

  it('handoff, open-session y show-detail', () => {
    const s = sug({ actions: [{ kind: 'handoff', label: 'T' }, { kind: 'open-session', label: 'O' }, { kind: 'show-detail', label: 'D' }] });
    expect(planAction(s, 0, 'codex')).toEqual({ kind: 'handoff', sessionId: 's1', source: 'codex' });
    expect(planAction(s, 1, 'codex')).toMatchObject({ kind: 'open-dashboard', sessionId: 's1' });
    expect(planAction(s, 2, 'codex')).toEqual({ kind: 'show-detail', message: 'Contexto alto' });
  });

  it('traspaso CLI incluye el comando de limpieza del cliente', () => {
    const cc = handoffClipboardText({ summary: 'Objetivo: X', method: 'claude-cli' }, 'claude-code');
    expect(cc.text).toContain('Objetivo: X');
    expect(cc.text).toContain('/clear');
    expect(handoffClipboardText({ summary: 'S', method: 'extractive' }, 'codex').text).toContain('/new');
    expect(handoffClipboardText({ summary: 'S', method: 'extractive' }, 'gemini-cli').message).toContain('extractivo');
  });

  it('traspaso web/desktop: sólo el resumen', () => {
    const w = handoffClipboardText({ summary: '  resumen  ', method: 'claude-cli' }, 'web');
    expect(w.text).toBe('resumen');
    expect(w.message).toContain('chat nuevo');
  });
});
