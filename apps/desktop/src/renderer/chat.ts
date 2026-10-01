import { fmtPct, fmtTokens } from '@contextpilot/core';
import type { ChatBlock, ChatMessage, ChatState } from '../shared/chat.js';
import { CHAT_MODELS, chatName, mcpSummary, slashSuggestions, STATUS_TEXT, toolSummary } from '../shared/chatView.js';
import type { AppSnapshot, ChatRecordView } from '../shared/types.js';
import { clear, cp, h, toast } from './dom.js';
import { sessionCardElement } from './live.js';
import { markdown } from './markdownDom.js';

// Pestaña «Chat»: conversaciones con Claude manejadas desde ContextPilot (el `claude` CLI con el
// login del usuario). Columnas: lista de chats · conversación · tarjeta de la sesión en vivo.
// Los mensajes se redibujan por mensaje (firma) para que el streaming no rehaga todo el historial.

const st = {
  list: [] as ChatRecordView[],
  current: undefined as string | undefined,
  state: undefined as ChatState | undefined,
  snapshot: undefined as AppSnapshot | undefined,
  rendered: new Map<string, { el: HTMLElement; sig: string }>(),
  newModel: '',
  subscribed: false,
};

let rootEl: HTMLElement | undefined;

function sessionNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of st.snapshot?.sessions ?? []) out[r.sessionId] = r.label;
  return out;
}

function subscribe(): void {
  if (st.subscribed) return;
  st.subscribed = true;
  cp().chat.onUpdate((s) => {
    if (s.id !== st.current) return;
    st.state = s;
    if (rootEl?.isConnected) renderConversation();
  });
  cp().chat.onList((l) => {
    st.list = l;
    if (rootEl?.isConnected) renderList();
  });
}

/** Dibuja la pestaña completa. */
export async function renderChat(root: HTMLElement, snap: AppSnapshot | undefined): Promise<void> {
  subscribe();
  rootEl = root;
  st.snapshot = snap;
  st.rendered.clear();
  clear(root);
  root.append(
    h('div', { class: 'chat' },
      h('aside', { class: 'chat-list', 'aria-label': 'Conversaciones' }),
      h('section', { class: 'chat-main', 'aria-label': 'Conversación' }),
      h('aside', { class: 'chat-side', 'aria-label': 'Sesión en vivo' })),
  );
  st.list = await cp().chat.list();
  if (!st.current && st.list[0]) await select(st.list[0].id);
  else if (st.current) st.state = (await cp().chat.open(st.current)) ?? undefined;
  renderList();
  renderConversation(true);
  renderSide();
}

/** Snapshot nuevo del daemon: actualiza nombres y la tarjeta lateral. */
export function updateChatSnapshot(snap: AppSnapshot | undefined): void {
  st.snapshot = snap;
  if (!rootEl?.isConnected) return;
  renderList();
  renderSide();
}

async function select(id: string): Promise<void> {
  st.current = id;
  st.rendered.clear();
  st.state = (await cp().chat.open(id)) ?? undefined;
}

async function newChat(): Promise<void> {
  const r = await cp().chat.create(st.newModel || undefined);
  if (!r) return;
  st.list = r.list;
  st.current = r.state.id;
  st.state = r.state;
  st.rendered.clear();
  renderList();
  renderConversation(true);
  renderSide();
  rootEl?.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
}

// ---------- lista ----------

function renderList(): void {
  const el = rootEl?.querySelector<HTMLElement>('.chat-list');
  if (!el) return;
  clear(el);
  const names = sessionNames();
  el.append(
    h('div', { class: 'chat-new' },
      h('button', { class: 'primary', onclick: () => void newChat(), title: 'Elegí la carpeta de trabajo; el chat corre ahí con tus skills, MCP y CLAUDE.md' }, '+ Nuevo chat'),
      h('select', { 'aria-label': 'Modelo del chat nuevo', onchange: (e: Event) => (st.newModel = (e.target as HTMLSelectElement).value) },
        ...CHAT_MODELS.map((m) => h('option', { value: m.value, selected: m.value === st.newModel }, m.label)))),
  );
  if (!st.list.length) {
    el.append(h('p', { class: 'muted small' }, 'Sin chats todavía. Cada chat corre Claude Code con tu login, en la carpeta que elijas.'));
    return;
  }
  el.append(
    h('ul', { role: 'list' },
      ...st.list.map((c) =>
        h('li', { class: c.id === st.current ? 'active' : '' },
          h('button', { class: 'chat-item', onclick: () => void select(c.id).then(() => { renderList(); renderConversation(true); renderSide(); }) },
            h('span', { class: 'chat-item-name' }, chatName(c, names)),
            h('span', { class: 'muted small' }, new Date(c.updatedAt).toLocaleString())),
          h('button', { class: 'chat-del', title: 'Quitar de la lista (el transcript de Claude Code queda)', 'aria-label': 'Quitar chat', onclick: async () => {
            st.list = await cp().chat.remove(c.id);
            if (st.current === c.id) {
              st.current = undefined;
              st.state = undefined;
            }
            renderList();
            renderConversation(true);
            renderSide();
          } }, '×')))),
  );
}

// ---------- conversación ----------

function blockEl(b: ChatBlock): HTMLElement {
  if (b.kind === 'text') return markdown(b.text);
  if (b.kind === 'thinking') return h('details', { class: 'thinking' }, h('summary', {}, 'Razonamiento'), h('pre', {}, b.text));
  const status = !b.done ? 'run' : b.isError ? 'err' : 'ok';
  const icon = status === 'run' ? '⏳' : status === 'err' ? '✖' : '✓';
  return h('details', { class: `tool tool-${status}` },
    h('summary', {}, h('span', { class: 'tool-icon' }, icon), toolSummary(b.name, b.input)),
    h('pre', { class: 'tool-input' }, b.inputJson ?? JSON.stringify(b.input, null, 2)),
    b.result !== undefined ? h('pre', { class: 'tool-result' }, b.result || '(sin salida)') : null);
}

function messageEl(m: ChatMessage): HTMLElement {
  return h('div', { class: `msg msg-${m.role}${m.streaming ? ' streaming' : ''}`, 'data-id': m.id }, ...m.blocks.map(blockEl));
}

function renderConversation(full = false): void {
  const el = rootEl?.querySelector<HTMLElement>('.chat-main');
  if (!el) return;
  const s = st.state;
  if (!s) {
    clear(el);
    el.append(h('div', { class: 'chat-empty card' },
      h('strong', {}, 'Chat de ContextPilot'),
      h('p', { class: 'muted' }, 'Conversá con Claude desde acá: ContextPilot ve cada turno en vivo y puede ejecutar las buenas prácticas (compactar, cambiar de modelo, apagar MCP) directamente en la sesión.'),
      h('button', { class: 'primary', onclick: () => void newChat() }, 'Nuevo chat')));
    return;
  }
  let head = el.querySelector<HTMLElement>('.chat-head');
  let log = el.querySelector<HTMLElement>('.chat-log');
  let perms = el.querySelector<HTMLElement>('.chat-perms');
  if (full || !head || !log || !perms) {
    clear(el);
    st.rendered.clear();
    head = h('header', { class: 'chat-head' });
    log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
    perms = h('div', { class: 'chat-perms' });
    el.append(head, log, perms, composer());
  }
  renderHead(head, s);

  // Mensajes: sólo se rehacen los que cambiaron.
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const ids = new Set(s.messages.map((m) => m.id));
  for (const [id, r] of st.rendered) if (!ids.has(id)) {
    r.el.remove();
    st.rendered.delete(id);
  }
  let prev: HTMLElement | null = null;
  for (const m of s.messages) {
    const sig = JSON.stringify(m);
    const cur = st.rendered.get(m.id);
    let node = cur?.el;
    if (!cur || cur.sig !== sig) {
      const fresh = messageEl(m);
      // Conserva qué herramientas/razonamientos estaban abiertos.
      if (cur) {
        const open = [...cur.el.querySelectorAll('details')].map((d) => d.open);
        fresh.querySelectorAll('details').forEach((d, i) => (d.open = open[i] ?? false));
        cur.el.replaceWith(fresh);
      }
      node = fresh;
      st.rendered.set(m.id, { el: fresh, sig });
    }
    const want: ChildNode | null = prev ? prev.nextSibling : log.firstChild;
    if (want !== node) log.insertBefore(node!, want);
    prev = node!;
  }
  if (nearBottom || full) log.scrollTop = log.scrollHeight;

  // Pedidos de permiso.
  clear(perms);
  for (const p of s.pending) {
    perms.append(h('div', { class: 'perm card', role: 'alertdialog', 'aria-label': `Permiso para ${p.toolName}` },
      h('div', {}, h('strong', {}, 'Claude quiere usar '), toolSummary(p.toolName, p.input)),
      h('pre', { class: 'tool-input' }, JSON.stringify(p.input, null, 2)),
      h('div', { class: 'btns' },
        h('button', { class: 'primary', onclick: () => void act(() => cp().chat.permission(s.id, p.requestId, true)) }, 'Permitir'),
        h('button', { onclick: () => void act(() => cp().chat.permission(s.id, p.requestId, false)) }, 'Denegar'))));
  }
  updateComposer(s);
}

function renderHead(head: HTMLElement, s: ChatState): void {
  clear(head);
  const rec = st.list.find((c) => c.id === s.id);
  head.append(
    h('div', { class: 'chat-title' },
      h('strong', {}, rec ? chatName(rec, sessionNames()) : 'Chat'),
      h('span', { class: 'muted small mono', title: s.cwd }, s.cwd)),
    h('div', { class: 'chat-meta' },
      h('select', { 'aria-label': 'Modelo', disabled: s.status === 'running', onchange: (e: Event) => void act(() => cp().chat.setModel(s.id, (e.target as HTMLSelectElement).value)) },
        ...CHAT_MODELS.map((m) => h('option', { value: m.value, selected: (rec?.model ?? '') === m.value }, m.value ? m.label : `Predeterminado${s.model ? ` (${s.model})` : ''}`))),
      h('span', { class: `chat-status st-${s.status}` }, s.statusText && s.status !== 'error' ? `${STATUS_TEXT[s.status]} · ${s.statusText}` : STATUS_TEXT[s.status]),
      mcpSummary(s) ? h('span', { class: 'muted small' }, mcpSummary(s)) : null),
    ...(s.status === 'error' && s.statusText ? [h('div', { class: 'chat-error', role: 'alert' }, s.statusText)] : []),
  );
}

// ---------- compositor ----------

function composer(): HTMLElement {
  const ta = h('textarea', { rows: 3, placeholder: 'Escribí tu mensaje… (Enter envía · Shift+Enter nueva línea · «/» para skills y comandos)', 'aria-label': 'Mensaje' }) as HTMLTextAreaElement;
  const menu = h('ul', { class: 'slash-menu hidden', role: 'listbox' });
  const send = async () => {
    const s = st.state;
    const text = ta.value.trim();
    if (!s || !text) return;
    ta.value = '';
    menu.classList.add('hidden');
    const r = await cp().chat.send(s.id, text);
    if (!r.ok) {
      toast(r.message, true);
      ta.value = text;
    }
  };
  const refreshMenu = () => {
    const s = st.state;
    clear(menu);
    const items = s ? slashSuggestions(s, ta.value) : [];
    menu.classList.toggle('hidden', !items.length);
    for (const it of items) {
      menu.append(h('li', { role: 'option' },
        h('button', { onclick: () => {
          ta.value = `/${it.value} `;
          menu.classList.add('hidden');
          ta.focus();
        } }, h('span', {}, `/${it.value}`), h('span', { class: `pill ${it.kind === 'skill' ? 'ok' : ''}` }, it.kind))));
    }
  };
  ta.addEventListener('input', refreshMenu);
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape') menu.classList.add('hidden');
  });
  return h('div', { class: 'composer' },
    menu,
    ta,
    h('div', { class: 'composer-btns' },
      h('button', { class: 'primary send', onclick: () => void send() }, 'Enviar'),
      h('button', { class: 'stop hidden', onclick: () => st.state && void act(() => cp().chat.interrupt(st.state!.id)) }, 'Detener')));
}

function updateComposer(s: ChatState): void {
  const root = rootEl?.querySelector('.composer');
  if (!root) return;
  const busy = s.status === 'running' || s.status === 'starting';
  root.querySelector('.stop')?.classList.toggle('hidden', !busy);
}

// ---------- lateral ----------

function renderSide(): void {
  const el = rootEl?.querySelector<HTMLElement>('.chat-side');
  if (!el) return;
  clear(el);
  const s = st.state;
  if (!s) return;
  const row = s.sessionId ? st.snapshot?.sessions.find((r) => r.sessionId === s.sessionId) : undefined;
  if (row?.view) el.append(sessionCardElement(row));
  else el.append(h('div', { class: 'card muted small' }, s.sessionId ? 'La tarjeta aparece cuando el daemon registra el primer turno de esta sesión.' : 'La tarjeta de la sesión aparece al enviar el primer mensaje.'));
  const r = s.lastResult;
  const rl = s.rateLimit;
  el.append(h('div', { class: 'card chat-stats' },
    h('strong', {}, 'Último turno'),
    r
      ? h('dl', {},
          h('dt', {}, 'Entrada'), h('dd', {}, fmtTokens(r.inputTokens + r.cacheRead + r.cacheWrite)),
          h('dt', {}, 'De caché'), h('dd', {}, fmtTokens(r.cacheRead)),
          h('dt', {}, 'Salida'), h('dd', {}, fmtTokens(r.outputTokens)),
          r.durationMs !== undefined ? [h('dt', {}, 'Duración'), h('dd', {}, `${(r.durationMs / 1000).toFixed(1)} s`)] : null)
      : h('p', { class: 'muted small' }, '—'),
    rl ? h('p', { class: 'small' }, `Plan: ventana de 5 h ${rl.fiveHour !== undefined ? fmtPct(rl.fiveHour) : '—'} · 7 días ${rl.sevenDay !== undefined ? fmtPct(rl.sevenDay) : '—'}`) : null));
  if (s.skills.length) {
    el.append(h('details', { class: 'card chat-skills' },
      h('summary', {}, `Skills disponibles (${s.skills.length})`),
      h('ul', {}, ...s.skills.map((k) => h('li', {}, h('code', {}, `/${k}`))))));
  }
}

async function act(fn: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
  const r = await fn();
  toast(r.message, !r.ok);
}
