// Service worker MV3: token/URL desde chrome.storage, cola hacia /ingest/events, WS /stream,
// ruteo de sugerencias a la pestaña de la sesión, badge por pestaña y estado para el side panel.
import type { AdapterHealth, Config, SessionView, Suggestion } from '@contextpilot/core';
import { badgeFor, EMPTY_BADGE, type BadgeSpec } from '../bg/badge.js';
import { DaemonClient, DEFAULT_DAEMON_URL, HttpError, type Settings } from '../bg/daemon.js';
import { EventQueue } from '../bg/queue.js';
import { StreamClient, type ServerMsg } from '../bg/stream.js';
import type { HandoffResponse, PanelState, TabStatus, ToBackground, ToContent } from '../messages.js';
import { SITES, siteForHost, type SiteId } from '../sites.js';
import { webRulesFor } from '../rules.js';

// --- estado ------------------------------------------------------------------------------------

let settings: Settings = { token: '', daemonUrl: DEFAULT_DAEMON_URL };
let daemon: PanelState['daemon'] = 'unconfigured';
let health: AdapterHealth[] = [];
const sessions = new Map<string, SessionView>();
const current = new Map<string, Suggestion>(); // sugerencia visible por sesión
const tabs = new Map<number, TabStatus>();

const client = new DaemonClient(() => settings);

const queue = new EventQueue(
  {
    load: async () => ((await chrome.storage.local.get('cpQueue')).cpQueue as never[]) ?? [],
    save: async (events) => chrome.storage.local.set({ cpQueue: events }),
  },
  (events) => client.sendBatch(events, (sugs) => sugs.forEach(onSuggestion)),
);

const stream = new StreamClient(
  () => (settings.token ? client.streamUrl() : null),
  {
    onOpen: () => {
      setDaemon('up');
      queue.kick();
    },
    onClose: (code) => (code === 4401 ? setDaemon('unauthorized') : void probeDaemon()),
    onMessage: onServerMsg,
  },
);

const ready = (async () => {
  const s = await chrome.storage.local.get(['cpToken', 'cpDaemonUrl']);
  settings = { token: (s.cpToken as string) ?? '', daemonUrl: (s.cpDaemonUrl as string) || DEFAULT_DAEMON_URL };
  const saved = await chrome.storage.session.get(['cpTabs', 'cpSessions']).catch(() => ({}) as Record<string, unknown>);
  for (const [k, v] of Object.entries((saved.cpTabs as Record<string, TabStatus>) ?? {})) tabs.set(Number(k), v);
  for (const v of (saved.cpSessions as SessionView[]) ?? []) sessions.set(v.sessionId, v);
  daemon = settings.token ? 'down' : 'unconfigured';
  stream.ensure();
  void queue.flush();
  refreshAllBadges();
})();

function persist(): void {
  void chrome.storage.session
    .set({ cpTabs: Object.fromEntries(tabs), cpSessions: [...sessions.values()].slice(-50) })
    .catch(() => undefined);
}

function setDaemon(d: PanelState['daemon']): void {
  if (daemon === d) return;
  daemon = d;
  refreshAllBadges();
  notifyPanel();
}

async function probeDaemon(): Promise<void> {
  if (!settings.token) return setDaemon('unconfigured');
  const r = await client.testConnection();
  setDaemon(r.health === 'down' ? 'down' : r.auth === 'unauthorized' ? 'unauthorized' : r.auth === 'ok' ? 'up' : 'down');
}

// --- WS ------------------------------------------------------------------------------------------

function onServerMsg(m: ServerMsg): void {
  switch (m.type) {
    case 'hello':
      health = m.data.health ?? [];
      for (const v of m.data.sessions ?? []) sessions.set(v.sessionId, v);
      for (const s of m.data.suggestions ?? []) onSuggestion(s);
      refreshAllBadges();
      break;
    case 'session':
      sessions.set(m.data.sessionId, m.data);
      refreshBadgesFor(m.data.sessionId);
      break;
    case 'suggestion':
      onSuggestion(m.data);
      break;
    case 'suggestion-cleared':
      if (current.get(m.data.sessionId)?.id === m.data.id) current.delete(m.data.sessionId);
      toTabs(m.data.sessionId, { type: 'cp:suggestion-cleared', id: m.data.id });
      break;
    case 'health':
      health = m.data ?? [];
      refreshAllBadges();
      break;
  }
  persist();
  notifyPanel();
}

function onSuggestion(s: Suggestion): void {
  if (!s.quiet) current.set(s.sessionId, s);
  toTabs(s.sessionId, { type: 'cp:suggestion', suggestion: s });
  notifyPanel();
}

function toTabs(sessionId: string, msg: ToContent): void {
  for (const [tabId, st] of tabs) {
    if (st.sessionId === sessionId) chrome.tabs.sendMessage(tabId, msg).catch(() => undefined);
  }
}

function notifyPanel(): void {
  chrome.runtime.sendMessage({ type: 'cp:state-changed' }).catch(() => undefined);
}

// --- badge ---------------------------------------------------------------------------------------

/** Salud del adaptador web en el daemon ('web', o uno específico del sitio si existiera). */
function siteHealth(site: SiteId): AdapterHealth | undefined {
  return health.find((h) => h.name.includes(site)) ?? health.find((h) => h.name === 'web');
}

function badgeForTab(st: TabStatus | undefined): BadgeSpec {
  if (!st) return EMPTY_BADGE;
  if (daemon !== 'up' || st.health === 'error' || ['error', 'disabled'].includes(siteHealth(st.site)?.status ?? 'ok')) return badgeFor(null, 'no-data');
  if (!st.sessionId) return EMPTY_BADGE;
  const v = sessions.get(st.sessionId);
  if (!v) return EMPTY_BADGE;
  return badgeFor(v.contextPct * 100);
}

function applyBadge(tabId: number): void {
  const b = badgeForTab(tabs.get(tabId));
  chrome.action.setBadgeText({ tabId, text: b.text }).catch(() => undefined);
  chrome.action.setBadgeBackgroundColor({ tabId, color: b.color }).catch(() => undefined);
  chrome.action.setTitle({ tabId, title: b.title }).catch(() => undefined);
}

function refreshBadgesFor(sessionId: string): void {
  for (const [tabId, st] of tabs) if (st.sessionId === sessionId) applyBadge(tabId);
}

function refreshAllBadges(): void {
  for (const tabId of tabs.keys()) applyBadge(tabId);
}

// --- mensajes de content scripts / panel / opciones ------------------------------------------

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as ToBackground;
  void ready.then(async () => {
    stream.ensure(); // reconexión oportunista: cualquier evento despierta el WS
    try {
      sendResponse(await handle(msg, sender));
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return true; // respuesta asíncrona
});

async function handle(msg: ToBackground, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'cp:events':
      await queue.push(msg.events);
      return { ok: true, queued: queue.size };
    case 'cp:tab-status': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { ok: false };
      const prev = tabs.get(tabId);
      tabs.set(tabId, msg.status);
      persist();
      applyBadge(tabId);
      if (msg.status.sessionId && msg.status.sessionId !== prev?.sessionId) void hydrateSession(msg.status.sessionId, tabId);
      notifyPanel();
      return { ok: true };
    }
    case 'cp:feedback':
      if (current.get(msg.sessionId)?.id === msg.id) current.delete(msg.sessionId);
      if (!stream.send({ type: 'feedback', data: { id: msg.id, feedback: msg.feedback, surface: 'extension' } })) {
        await client.feedback(msg.id, msg.feedback).catch(() => undefined);
      }
      notifyPanel();
      return { ok: true };
    case 'cp:handoff':
      return handoff(msg.sessionId, msg.content);
    case 'cp:run-handoff': {
      // Desde el side panel: la pestaña de la sesión extrae el DOM y ejecuta el traspaso.
      const s = current.get(msg.sessionId);
      if (!s || s.id !== msg.suggestionId) return { ok: false };
      toTabs(msg.sessionId, { type: 'cp:run-handoff', suggestion: s });
      return { ok: true };
    }
    case 'cp:panel-state':
      return panelState(msg.tabId);
    case 'cp:set-rule':
      return setRule(msg.ruleId, msg.enabled);
    case 'cp:test-connection': {
      if (msg.token !== undefined || msg.daemonUrl !== undefined) {
        const tmp = new DaemonClient(() => ({ token: msg.token ?? settings.token, daemonUrl: msg.daemonUrl || settings.daemonUrl }));
        return tmp.testConnection();
      }
      return client.testConnection();
    }
    case 'cp:settings-changed': {
      const s = await chrome.storage.local.get(['cpToken', 'cpDaemonUrl']);
      settings = { token: (s.cpToken as string) ?? '', daemonUrl: (s.cpDaemonUrl as string) || DEFAULT_DAEMON_URL };
      stream.restart();
      await probeDaemon();
      queue.kick();
      return { ok: true };
    }
  }
}

/** Al entrar a una conversación: estado y sugerencia vigente (el banner aparece tras recargar). */
async function hydrateSession(sessionId: string, tabId: number): Promise<void> {
  if (!settings.token) return;
  try {
    const d = await client.session(sessionId);
    sessions.set(sessionId, d.view);
    applyBadge(tabId);
    const active = await client.suggestions(sessionId).catch(() => [] as Suggestion[]);
    const visible = active.find((s) => !s.quiet);
    if (visible) {
      current.set(sessionId, visible);
      chrome.tabs.sendMessage(tabId, { type: 'cp:suggestion', suggestion: visible } satisfies ToContent).catch(() => undefined);
    }
    persist();
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) void probeDaemon();
  }
}

async function handoff(sessionId: string, content: string): Promise<HandoffResponse> {
  if (!settings.token) return { ok: false, error: 'falta configurar el token en Opciones' };
  try {
    const r = await client.handoff(sessionId, content);
    return { ok: true, summary: r.summary };
  } catch (e) {
    return { ok: false, error: e instanceof HttpError ? `HTTP ${e.status}` : 'daemon no disponible' };
  }
}

async function setRule(ruleId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = await client.getConfig();
    const cur = cfg.rules[ruleId];
    if (!cur) return { ok: false, error: 'regla desconocida' };
    await client.putConfig({ rules: { [ruleId]: { ...cur, enabled } } } as Partial<Config>);
    notifyPanel();
    return { ok: true };
  } catch {
    return { ok: false, error: 'daemon no disponible' };
  }
}

async function panelState(tabId?: number): Promise<PanelState> {
  if (tabId === undefined) {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = t?.id;
    if (t?.id !== undefined && !tabs.has(t.id) && t.url) {
      // Pestaña sin content script (p. ej. recién instalada la extensión)
      const site = siteForHost(new URL(t.url).hostname);
      if (!site) tabId = undefined;
    }
  }
  const tab = tabId !== undefined ? tabs.get(tabId) ?? null : null;
  const site = tab?.site ?? null;
  const state: PanelState = {
    daemon,
    site,
    tab,
    session: null,
    current: null,
    history: [],
    savings: { session: 0, total: null },
    rules: [],
    health,
    queueSize: queue.size,
  };
  if (daemon !== 'up' && daemon !== 'down') return state;
  // D-1: la sugerencia de cuenta (R10) llega con sessionId `account:<proveedor>`.
  if (site) state.account = current.get(`account:${SITES[site].provider}`) ?? null;
  const sid = tab?.sessionId;
  const tasks: Promise<unknown>[] = [];
  if (sid) {
    state.session = sessions.get(sid) ?? null;
    state.current = current.get(sid) ?? null;
    tasks.push(
      client
        .session(sid)
        .then((d) => {
          state.session = d.view;
          sessions.set(sid, d.view);
          state.history = [...d.suggestions].reverse();
          state.savings.session = d.suggestions
            .filter((s) => s.feedback === 'accepted')
            .reduce((n, s) => n + (s.estimatedSavingTokens ?? 0), 0);
        })
        .catch(() => undefined),
    );
  }
  tasks.push(
    client
      .stats()
      .then((st) => {
        state.savings.total = (st.byRule ?? []).reduce((n, r) => n + (r.savedTokens ?? 0), 0);
      })
      .catch(() => undefined),
  );
  if (site) {
    tasks.push(
      client
        .getConfig()
        .then((cfg) => {
          state.rules = webRulesFor(site).map((r) => ({ ...r, enabled: cfg.rules[r.id]?.enabled ?? true }));
        })
        .catch(() => undefined),
    );
  }
  await Promise.all(tasks);
  return state;
}

// --- ciclo de vida -------------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void ready.then(() => {
    if (!settings.token) chrome.runtime.openOptionsPage().catch(() => undefined);
  });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  persist();
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ready.then(() => {
    stream.ensure();
    applyBadge(tabId);
  });
});
// Side panel abierto: port con pings periódicos → mantiene vivo el service worker y el WS.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cp-panel') return;
  port.onMessage.addListener(() => {
    void ready.then(() => stream.ensure());
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.cpToken || changes.cpDaemonUrl)) void handle({ type: 'cp:settings-changed' }, {});
});
