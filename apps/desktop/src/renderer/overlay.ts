import { fmtPct } from '@contextpilot/core';
import type { AppSnapshot, SessionRow } from '../shared/types.js';
import { clear, cp, h, toast } from './dom.js';

// Overlay del tray (CP-046): sesiones activas, medidor (≈ si estimado) y sugerencia vigente con acciones.

let focusId: string | undefined;
let busy = false;

async function act(fn: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try {
    const r = await fn();
    toast(r.message, !r.ok);
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

function sessionEl(r: SessionRow): HTMLElement {
  const pct = r.contextPct === null ? 0 : Math.min(1, r.contextPct);
  const nums = r.noData ? 'sin datos' : `${r.meterText} · ${r.cacheText}`;
  const el = h(
    'div',
    { class: 'session' },
    h('div', { class: 'row1' }, h('span', { class: 'name', title: `${r.sessionId} · ${r.model}` }, r.label), h('span', { class: 'nums' }, nums)),
    h('div', { class: `meter ${r.meterLevel}`, role: 'meter', 'aria-valuenow': Math.round(pct * 100), 'aria-label': 'Ocupación de contexto' },
      h('i', { style: `width:${(pct * 100).toFixed(1)}%` })),
  );
  const s = r.suggestion;
  if (s) {
    const btns = h('div', { class: 'btns' });
    for (const a of s.actions) {
      btns.append(h('button', { class: a.index === 0 ? 'primary' : '', onclick: () => act(() => cp().runAction(s.id, a.index)) }, a.label));
    }
    btns.append(
      h('button', { onclick: () => act(() => cp().feedback(s.id, 'accepted')), title: 'Marcar como aceptada' }, 'Aceptar'),
      h('button', { onclick: () => act(() => cp().feedback(s.id, 'dismissed')) }, 'Ignorar'),
      h('button', { onclick: () => act(() => cp().feedback(s.id, 'snoozed')) }, 'Posponer 15 min'),
    );
    el.append(
      h(
        'div',
        { class: `sug ${s.severity}${focusId === s.id ? ' focus' : ''}`, 'data-id': s.id },
        h('div', { class: 'title' }, `${s.severity === 'critical' ? '⛔ ' : s.severity === 'warn' ? '⚠ ' : 'ℹ '}${s.title}`),
        h('div', { class: 'detail' }, s.detail, s.savingText ? ` · ${s.savingText}` : ''),
        btns,
      ),
    );
  }
  return el;
}

export function render(snap: AppSnapshot): void {
  const dot = document.getElementById('dot')!;
  dot.className = `dot ${snap.trayColor}`;
  dot.title = snap.trayColor;
  const body = document.getElementById('body')!;
  clear(body);
  if (snap.connection !== 'connected') {
    body.append(
      h('div', { class: 'empty' }, h('div', {}, 'Daemon no disponible'), h('div', { class: 'muted' }, snap.lastError ?? 'Reintentando conexión…')),
    );
  }
  if (snap.planUsage) {
    const p = snap.planUsage;
    body.append(
      h('div', { class: 'plan', title: `Fuente: Claude Desktop (plan-usage-history.json) · ${p.sampledAt}` },
        `Plan Claude: ventana 5 h ${fmtPct(p.fiveHourPct)} · 7 días ${fmtPct(p.sevenDayPct)}${p.stale ? ' (desactualizado)' : ''}`),
    );
  }
  if (snap.connection === 'connected' && !snap.sessions.length) body.append(h('div', { class: 'empty' }, 'Sin sesiones activas'));
  for (const r of snap.sessions) body.append(sessionEl(r));
  const foot = document.getElementById('desktopStatus')!;
  foot.textContent = `Claude Desktop: ${snap.desktopAdapter.status === 'disabled' ? 'captura apagada' : snap.desktopAdapter.detail}`;
  foot.className = `muted status-dot status-${snap.desktopAdapter.status}`;
  if (focusId) document.querySelector(`.sug[data-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center' });
}

async function init(): Promise<void> {
  document.getElementById('btnDash')!.addEventListener('click', () => void cp().openDashboard());
  document.getElementById('btnClose')!.addEventListener('click', () => void cp().hideOverlay());
  window.addEventListener('keydown', (e) => e.key === 'Escape' && void cp().hideOverlay());
  let last: AppSnapshot | undefined;
  cp().onSnapshot((s) => {
    last = s;
    render(s);
  });
  cp().onFocusSuggestion((id) => {
    focusId = id;
    if (last) render(last);
  });
  render(await cp().getSnapshot());
  document.body.dataset.ready = '1';
}

void init();
