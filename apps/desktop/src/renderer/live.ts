import { accountStrip, cardSignature, liveCard, stableOrder, type AccountStrip, type LiveCard } from '../shared/live.js';
import type { AppSnapshot, SuggestionRow } from '../shared/types.js';
import { clear, cp, h, toast } from './dom.js';

// CP-059/CP-060: monitor «En vivo». Una tarjeta por sesión activa; se crean y se quitan solas con
// cada snapshot (mensajes WS `session`/`suggestion`/`suggestion-cleared` del daemon vía main).
// Las tarjetas se actualizan en el lugar (misma raíz) para que el cambio de color tenga transición
// y el foco del teclado no se pierda cuando nada cambió.

interface CardEntry {
  el: HTMLElement;
  sig: string;
}

const cards = new Map<string, CardEntry>();
let order: string[] = [];
let accountSig = '';
let busy = false;
/** Guías/detalles desplegados (clave del botón), para conservarlos entre redibujos. */
const expanded = new Set<string>();

async function act(fn: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const r = await fn();
    toast(r.message, !r.ok);
  } finally {
    busy = false;
  }
}

/** Botones de una sugerencia: sus acciones + aceptar / ignorar / posponer. */
function actionButtons(suggestionId: string, actions: SuggestionRow['actions'], keyPrefix: string): HTMLElement {
  const btns = h('div', { class: 'btns' });
  const details: HTMLElement[] = [];
  for (const a of actions) {
    const key = `${keyPrefix}:a${a.index}`;
    // Guía / ejemplo: se despliega en la tarjeta (un toast de 4 s no alcanza para leer pasos).
    if (a.kind === 'show-detail' && a.detail) {
      const open = expanded.has(key);
      btns.append(
        h('button', { 'data-key': key, 'aria-expanded': String(open), onclick: (e: Event) => {
          if (expanded.has(key)) expanded.delete(key);
          else expanded.add(key);
          const now = expanded.has(key);
          (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(now));
          (e.currentTarget as HTMLElement).textContent = `${a.label} ${now ? '▴' : '▾'}`;
          (e.currentTarget as HTMLElement).closest('.btns-wrap')?.querySelector<HTMLElement>(`[data-detail="${CSS.escape(key)}"]`)?.classList.toggle('hidden', !now);
        } }, open ? `${a.label} ▴` : `${a.label} ▾`),
      );
      details.push(h('pre', { class: `guide${open ? '' : ' hidden'}`, 'data-detail': key }, a.detail));
      continue;
    }
    btns.append(
      h('button', { class: a.index === 0 ? 'primary' : '', 'data-key': key, onclick: () => act(() => cp().runAction(suggestionId, a.index)) }, a.label),
    );
  }
  btns.append(
    h('button', { 'data-key': `${keyPrefix}:ok`, title: 'Marcar como aceptada (ya lo hice)', onclick: () => act(() => cp().feedback(suggestionId, 'accepted')) }, 'Aceptar'),
    h('button', { 'data-key': `${keyPrefix}:no`, onclick: () => act(() => cp().feedback(suggestionId, 'dismissed')) }, 'Ignorar'),
    h('button', { 'data-key': `${keyPrefix}:zz`, onclick: () => act(() => cp().feedback(suggestionId, 'snoozed')) }, 'Posponer 15 min'),
  );
  return h('div', { class: 'btns-wrap' }, btns, ...details);
}

/** R6/R11: MCP desactivados por ContextPilot en el proyecto, con «Reactivar» por servidor. */
function mcpSection(c: LiveCard): HTMLElement {
  const reactivate = (servers: string[]) =>
    act(async () => {
      const r = await cp().api<{ servers: string[] }>('POST', '/mcp/enable', { sessionId: c.sessionId, servers });
      if (!r.ok) return { ok: false, message: `No se pudo reactivar: ${r.error ?? r.status}` };
      return { ok: true, message: `Reactivado: ${servers.map((k) => c.mcpDisabled.find((m) => m.key === k)?.name ?? k).join(', ')}. Disponible desde el próximo turno (si no, /mcp o sesión nueva).` };
    });
  return h(
    'section',
    { class: 'mcp-off', 'aria-label': 'MCP desactivados en este proyecto' },
    h('div', { class: 'coach-kicker' }, 'MCP desactivados en este proyecto'),
    h('ul', {}, c.mcpDisabled.map((m) =>
      h('li', {}, h('span', {}, m.name), h('button', { 'data-key': `${c.sessionId}:mcp:${m.key}`, onclick: () => reactivate([m.key]) }, 'Reactivar')))),
    c.mcpDisabled.length > 1 ? h('button', { 'data-key': `${c.sessionId}:mcp:*`, onclick: () => reactivate(c.mcpDisabled.map((m) => m.key)) }, 'Reactivar todos') : null,
  );
}

const SEV_ICON: Record<string, string> = { critical: '⛔', warn: '⚠', info: 'ℹ' };

function cardBody(c: LiveCard): HTMLElement[] {
  const head = h(
    'header',
    { class: 'lc-head' },
    h('span', { class: `src-badge src-${c.source}`, title: c.badge.label, 'aria-label': `Fuente: ${c.badge.label}` }, c.badge.short),
    h('div', { class: 'lc-names' },
      h('div', { class: 'lc-name', title: c.name }, c.name),
      h('div', { class: 'lc-sub' }, h('span', { class: 'mono', title: c.sessionId }, c.shortId), ' · ', c.model),
    ),
    h('span', { class: `lc-state st-${c.color}` }, c.stateLabel),
  );
  const pct = c.ctxPct === null ? 0 : Math.min(1, Math.max(0, c.ctxPct));
  const gauge = h(
    'div',
    { class: 'lc-gauge' },
    h('div', { class: 'lc-gauge-top' }, h('span', { class: 'secondary' }, 'Contexto'), h('strong', {}, c.ctxText), h('span', { class: 'muted' }, c.ctxTokensText)),
    h('div', { class: `meter ${c.ctxLevel}`, role: 'meter', 'aria-label': 'Ocupación de contexto', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct * 100) },
      h('i', { style: `width:${(pct * 100).toFixed(1)}%` })),
  );
  const stat = (label: string, value: string, title?: string) => h('div', { class: 'lc-stat', title }, h('dt', {}, label), h('dd', {}, value));
  const stats = h(
    'dl',
    { class: 'lc-stats' },
    stat('Caché', c.cacheText, 'Proporción del contexto leída de caché en la última llamada'),
    stat('Turnos', c.turnsText, 'Prompts del usuario en la sesión'),
    stat('Ritmo', c.burnText, 'Tokens efectivos por minuto (media de 15 min; la lectura de caché pesa 0,1)'),
    stat('Actividad', c.lastText),
  );
  const out = [head, gauge, stats];
  if (c.coaching) {
    const k = c.coaching;
    out.push(
      h(
        'section',
        { class: `coach sev-${k.severity}`, 'aria-label': 'Buena práctica' },
        h('div', { class: 'coach-kicker' }, `Buena práctica · ${k.ruleId} ${k.ruleName}`),
        h('div', { class: 'coach-title' }, `${SEV_ICON[k.severity] ?? ''} ${k.title}`),
        h('p', {}, h('b', {}, 'Qué pasa: '), k.what),
        h('p', {}, h('b', {}, 'Por qué cuesta: '), k.why),
        h('p', {}, h('b', {}, 'Qué hacer ahora: '), k.action, k.savingText ? h('span', { class: 'muted' }, ` (${k.savingText})`) : null),
        actionButtons(k.suggestionId, k.actions, `${c.sessionId}:${k.suggestionId}`),
        k.habit ? h('p', { class: 'habit' }, h('b', {}, 'Hábito: '), k.habit) : null,
      ),
    );
  } else if (c.tip) {
    out.push(h('div', { class: 'tip', role: 'note' }, h('b', {}, 'Consejo: '), c.tip));
  }
  if (c.mcpDisabled.length) out.push(mcpSection(c));
  return out;
}

function applyCard(el: HTMLElement, c: LiveCard): void {
  // Conserva el foco si el botón enfocado sigue existiendo tras el redibujo.
  const active = document.activeElement as HTMLElement | null;
  const key = active && el.contains(active) ? active.dataset.key : undefined;
  el.className = `lcard st-${c.color}`;
  el.setAttribute('aria-label', `${c.name}: ${c.stateLabel}`);
  clear(el);
  el.append(...cardBody(c));
  if (key) el.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

function accountSection(a: AccountStrip): HTMLElement {
  const sec = h('section', { class: 'acct card', 'aria-label': 'Cuenta y plan' });
  const plan = a.plan
    ? h(
        'div',
        { class: 'acct-plan' },
        h('span', { class: 'acct-title' }, 'Plan Claude'),
        a.plan.bars.map((b) =>
          h('div', { class: 'pbar' },
            h('div', { class: 'pbar-top' }, h('span', { class: 'secondary' }, b.label), h('strong', {}, b.text)),
            h('div', { class: `meter ${b.level}`, role: 'meter', 'aria-label': b.label, 'aria-valuenow': Math.round(b.pct * 100) },
              h('i', { style: `width:${Math.min(100, b.pct * 100).toFixed(1)}%` }))),
        ),
        h('span', { class: 'muted small' }, `Claude Desktop · ${a.plan.sampledText}${a.plan.stale ? ' (desactualizado)' : ''}`),
      )
    : h('div', { class: 'acct-plan muted' }, 'Sin datos del plan: abrí Claude Desktop (informa el uso de 5 h y 7 días) o configurá un perfil de plan en Configuración.');
  sec.append(plan);
  if (a.warnings.length) {
    for (const w of a.warnings) {
      sec.append(
        h('div', { class: `acct-warn sev-${w.severity}`, role: 'alert' },
          h('div', {}, h('strong', {}, `${SEV_ICON[w.severity] ?? ''} Cuenta ${w.providerName} · R10: `), w.title),
          h('div', { class: 'secondary small' }, w.detail),
          actionButtons(w.suggestionId, w.actions, `acct:${w.suggestionId}`)),
      );
    }
  } else {
    sec.append(h('div', { class: 'acct-ok' }, h('span', { class: 'pill ok' }, 'Sin aviso de límite (R10)')));
  }
  return sec;
}

/** Dibuja (o actualiza en el lugar) el monitor en vivo. */
export function renderLive(root: HTMLElement, snap: AppSnapshot | undefined, now = Date.now()): void {
  let wrap = root.querySelector<HTMLElement>(':scope > .live');
  if (!wrap) {
    clear(root);
    cards.clear();
    order = [];
    accountSig = '';
    wrap = h('div', { class: 'live' },
      h('div', { class: 'acct-slot' }),
      h('div', { class: 'live-head' }),
      h('div', { class: 'live-grid', role: 'list', 'aria-live': 'polite' }));
    root.append(wrap);
  }
  const acctSlot = wrap.querySelector<HTMLElement>('.acct-slot')!;
  const headEl = wrap.querySelector<HTMLElement>('.live-head')!;
  const grid = wrap.querySelector<HTMLElement>('.live-grid')!;

  const strip = accountStrip(snap ?? { account: [] }, now);
  const sig = JSON.stringify(strip);
  if (sig !== accountSig) {
    const active = document.activeElement as HTMLElement | null;
    const key = active && acctSlot.contains(active) ? active.dataset.key : undefined;
    clear(acctSlot);
    acctSlot.append(accountSection(strip));
    if (key) acctSlot.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
    accountSig = sig;
  }

  const connected = snap?.connection === 'connected';
  // Main de una versión anterior (sin `view` en las filas): no hay datos para las tarjetas.
  const rows = connected ? snap!.sessions.filter((r) => r.view) : [];
  const vms = new Map(rows.map((r) => [r.sessionId, liveCard(r, now)]));
  order = stableOrder(order, rows.map((r) => r.sessionId));

  clear(headEl);
  headEl.append(
    h('h2', {}, `Sesiones activas (${rows.length})`),
    h('span', { class: 'muted small' }, connected ? 'Se actualiza sola · activa = actividad en los últimos 30 min' : 'Daemon no disponible: reintentando conexión…'),
  );

  for (const [id, e] of cards) {
    if (!vms.has(id)) {
      e.el.remove();
      cards.delete(id);
    }
  }
  for (const id of order) {
    const vm = vms.get(id)!;
    const s = cardSignature(vm);
    const cur = cards.get(id);
    if (!cur) {
      const el = h('article', { role: 'listitem', 'data-session': id });
      applyCard(el, vm);
      el.classList.add('enter');
      cards.set(id, { el, sig: s });
    } else if (cur.sig !== s) {
      applyCard(cur.el, vm);
      cur.sig = s;
    }
  }
  // Orden del DOM = orden estable (sólo se mueve lo que cambió de lugar).
  const want = order.map((id) => cards.get(id)!.el);
  want.forEach((el, i) => {
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] ?? null);
  });
  wrap.querySelector('.live-empty')?.remove();
  if (!rows.length) {
    grid.after(
      h('div', { class: 'live-empty card' },
        h('strong', {}, connected ? 'Sin sesiones activas' : 'Sin conexión con el daemon'),
        h('p', { class: 'muted' }, connected
          ? 'Cuando trabajes con Claude Code, Claude Desktop, Codex, Gemini CLI o la web, cada sesión aparece acá como una tarjeta con su contexto, caché y consejos.'
          : 'El monitor se completa solo cuando el daemon responde.')),
    );
  }
}

/** Tarjeta de una sesión suelta (la usa el chat, al costado de la conversación). */
export function sessionCardElement(row: SnapshotSession, now = Date.now()): HTMLElement {
  const el = h('article', { 'data-session': row.sessionId });
  applyCard(el, liveCard(row, now));
  return el;
}

type SnapshotSession = AppSnapshot['sessions'][number];

/** Reinicia el estado del monitor (al salir de la pestaña). */
export function resetLive(): void {
  cards.clear();
  order = [];
  accountSig = '';
}
