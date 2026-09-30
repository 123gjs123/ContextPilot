// Render puro del side panel (CP-049.2/.3). Devuelve HTML escapado; el entry engancha eventos.
import { fmtTokens } from '@contextpilot/core';
import { levelFor } from '../bg/badge.js';
import type { PanelState } from '../messages.js';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const LEVEL_CLASS = { green: 'ok', yellow: 'warn', red: 'bad' } as const;
const LEVEL_COLOR = { green: 'var(--ok)', yellow: 'var(--warn)', red: 'var(--bad)' } as const;

export function daemonPill(d: PanelState['daemon']): { text: string; cls: string } {
  switch (d) {
    case 'up':
      return { text: 'daemon conectado', cls: 'ok' };
    case 'down':
      return { text: 'daemon: sin datos', cls: 'bad' };
    case 'unauthorized':
      return { text: 'token rechazado', cls: 'bad' };
    default:
      return { text: 'sin configurar', cls: 'warn' };
  }
}

export function renderPanel(st: PanelState): string {
  if (st.daemon === 'unconfigured')
    return `<div class="card"><p>Falta pegar el token del daemon.</p><button id="open-options" class="primary" type="button">Abrir opciones</button></div>`;
  if (st.daemon === 'unauthorized')
    return `<div class="card"><p class="bad">El daemon rechazó el token.</p><button id="open-options" type="button">Revisar token</button></div>`;
  if (!st.site) return `<div class="card muted">Abrí una conversación en claude.ai, chatgpt.com o gemini.google.com.</div>`;

  const parts: string[] = [];
  const noData = st.daemon !== 'up' || st.tab?.health === 'error';
  // Medidor
  if (noData) {
    const why = st.daemon !== 'up' ? 'el daemon no responde' : st.tab?.healthDetail ?? 'el adaptador del sitio falló';
    parts.push(`<div class="card"><div class="big gray">sin datos</div><div class="muted">${esc(why)}. Nunca mostramos cifras inventadas.</div></div>`);
  } else if (!st.session) {
    parts.push(`<div class="card"><div class="muted">${st.tab?.sessionId ? 'Todavía no hay turnos registrados en esta conversación.' : 'Chat nuevo: el medidor aparece después del primer turno.'}</div></div>`);
  } else {
    const pct = st.session.contextPct * 100;
    const lvl = levelFor(pct);
    parts.push(`<div class="card">
      <div class="row"><div class="big ${LEVEL_CLASS[lvl]} grow">≈${Math.floor(pct)} %</div><div class="muted">${esc(st.session.model)}</div></div>
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(pct)}" aria-label="Ocupación de contexto estimada"><span style="width:${Math.min(100, pct).toFixed(1)}%;background:${LEVEL_COLOR[lvl]}"></span></div>
      <div class="muted">≈${esc(fmtTokens(st.session.contextSize))} de ${esc(fmtTokens(st.session.contextWindow))} tokens · ${st.session.turns} turnos${st.session.estimated ? ' · estimado' : ''}</div>
      ${st.tab?.capture === 'fallback-dom' ? '<div class="warn">Captura por DOM (respaldo): la red no reportó los últimos turnos.</div>' : ''}
    </div>`);
  }
  // D-1: aviso de cuenta (límite del plan), independiente de la conversación.
  if (st.account) {
    const a = st.account;
    parts.push(`<div class="card account ${esc(a.severity)}" data-account="${esc(a.sessionId)}"><div class="muted">Cuenta</div><strong>${esc(a.title)}</strong><p class="muted">${esc(a.detail)}</p>
      <p class="row"><button type="button" data-act="dismiss-account" data-id="${esc(a.id)}">Ignorar</button></p></div>`);
  }
  // Sugerencia vigente
  parts.push('<h2>Sugerencia</h2>');
  if (st.current) {
    const s = st.current;
    parts.push(`<div class="card"><strong>${esc(s.title)}</strong><p class="muted">${esc(s.detail)}</p>
      ${s.estimatedSavingTokens ? `<div>Ahorro ≈${esc(fmtTokens(s.estimatedSavingTokens))} tokens</div>` : ''}
      <p class="row"><button type="button" class="primary" data-act="accept" data-id="${esc(s.id)}">${esc(s.actions.some((a) => a.kind === 'handoff') ? 'Generar resumen' : s.actions.find((a) => a.kind === 'copy')?.label ?? 'Aceptar')}</button>
      <button type="button" data-act="dismiss" data-id="${esc(s.id)}">Ignorar</button></p></div>`);
  } else parts.push('<div class="card muted">Nada por ahora.</div>');
  // Historial
  parts.push('<h2>Historial de esta conversación</h2>');
  if (st.history.length) {
    parts.push(
      `<div class="card"><ul class="list">${st.history
        .slice(0, 20)
        .map(
          (h) =>
            `<li><div>${esc(h.title)}${h.quiet ? ' <span class="pill gray">silenciosa</span>' : ''}</div><div class="muted">${esc(h.ruleId)} · ${esc(new Date(h.createdAt ?? h.expiresAt).toLocaleString('es-AR'))}${h.feedback ? ` · ${esc(feedbackLabel(h.feedback))}` : ''}</div></li>`,
        )
        .join('')}</ul></div>`,
    );
  } else parts.push('<div class="card muted">Sin sugerencias todavía.</div>');
  // Ahorro
  parts.push('<h2>Ahorro</h2>');
  parts.push(
    `<div class="card">Esta conversación: ≈${esc(fmtTokens(st.savings.session))} tokens<br/>Total aceptado: ${st.savings.total === null ? '<span class="muted">sin datos</span>' : `≈${esc(fmtTokens(st.savings.total))} tokens`}</div>`,
  );
  // Reglas
  if (st.rules.length) {
    parts.push('<h2>Reglas para chats web</h2><div class="card">');
    for (const r of st.rules)
      parts.push(`<label class="toggle"><span>${esc(r.id)} · ${esc(r.label)}</span><input type="checkbox" data-rule="${esc(r.id)}" ${r.enabled ? 'checked' : ''}/></label>`);
    parts.push('<div class="muted">Los cambios aplican a todos los chats web (config del daemon).</div></div>');
  }
  if (st.queueSize) parts.push(`<p class="muted">${st.queueSize} eventos en cola esperando al daemon.</p>`);
  return parts.join('\n');
}

function feedbackLabel(f: string): string {
  return ({ accepted: 'aceptada', dismissed: 'ignorada', snoozed: 'pospuesta', expired: 'vencida' } as Record<string, string>)[f] ?? f;
}
