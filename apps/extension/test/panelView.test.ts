// CP-049.2/.3: side panel con medidor ≈, turnos, sugerencia, historial, ahorro, reglas y «sin datos».
import type { SessionView } from '@contextpilot/core';
import { describe, expect, it } from 'vitest';
import type { PanelState } from '../src/messages.js';
import { renderPanel } from '../src/ui/panelView.js';

const session: SessionView = {
  sessionId: 'claude.ai:abc',
  source: 'web',
  provider: 'anthropic',
  client: 'claude.ai',
  model: 'claude-sonnet-4-5',
  turns: 12,
  contextSize: 124_000,
  contextWindow: 200_000,
  contextPct: 0.62,
  cachePct: null,
  estimated: true,
  lastTurnAt: '2026-09-30T12:00:00Z',
  status: 'active',
};

const base: PanelState = {
  daemon: 'up',
  site: 'claude.ai',
  tab: { site: 'claude.ai', sessionId: 'claude.ai:abc', capture: 'net', health: 'ok' },
  session,
  current: null,
  history: [],
  savings: { session: 0, total: 5000 },
  rules: [{ id: 'W1', label: 'Conversación larga', enabled: true }],
  health: [],
  queueSize: 0,
};

describe('renderPanel', () => {
  it('medidor con ≈, turnos, ahorro y toggles', () => {
    const html = renderPanel({
      ...base,
      current: {
        id: 's',
        ruleId: 'W1',
        sessionId: 'claude.ai:abc',
        severity: 'warn',
        title: 'Chat nuevo <b>ya</b>',
        detail: 'd',
        actions: [{ kind: 'handoff', label: 'x' }],
        expiresAt: '2030-01-01T00:00:00Z',
      },
      history: [{ id: 'h', ruleId: 'W3', sessionId: 'claude.ai:abc', severity: 'info', title: 'Regeneraste', detail: '', actions: [], expiresAt: '2026-09-30T12:00:00Z', feedback: 'dismissed' }],
    });
    expect(html).toContain('≈62 %');
    expect(html).toContain('12 turnos');
    expect(html).toContain('class="big warn');
    expect(html).toContain('Generar resumen');
    expect(html).toContain('&lt;b&gt;ya&lt;/b&gt;'); // escapado
    expect(html).toContain('ignorada');
    expect(html).toContain('≈5k tokens');
    expect(html).toContain('data-rule="W1"');
  });

  it('daemon caído o adaptador en error → «sin datos», sin cifras', () => {
    const down = renderPanel({ ...base, daemon: 'down' });
    expect(down).toContain('sin datos');
    expect(down).not.toContain('≈62');
    const err = renderPanel({ ...base, tab: { ...base.tab!, health: 'error', healthDetail: 'no se encontró el contenedor' } });
    expect(err).toContain('sin datos');
    expect(err).toContain('no se encontró el contenedor');
  });

  it('sin token → invita a abrir opciones', () => {
    expect(renderPanel({ ...base, daemon: 'unconfigured' })).toContain('open-options');
  });
});
