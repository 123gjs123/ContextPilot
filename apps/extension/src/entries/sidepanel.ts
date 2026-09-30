// Side panel (CP-049): pide estado al service worker y lo renderiza; mantiene vivo el SW con un port.
import type { PanelState, ToBackground } from '../messages.js';
import { daemonPill, renderPanel } from '../ui/panelView.js';

const root = document.getElementById('root')!;
const pill = document.getElementById('daemon')!;
let last: PanelState | null = null;

async function refresh(): Promise<void> {
  try {
    const st = (await chrome.runtime.sendMessage({ type: 'cp:panel-state' } satisfies ToBackground)) as PanelState;
    last = st;
    const p = daemonPill(st.daemon);
    pill.textContent = p.text;
    pill.className = `pill ${p.cls}`;
    root.innerHTML = renderPanel(st);
  } catch {
    pill.textContent = 'sin datos';
    pill.className = 'pill bad';
  }
}

root.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.id === 'open-options') void chrome.runtime.openOptionsPage();
  const act = t.dataset.act;
  const id = t.dataset.id;
  if (act && id && last?.current && last.tab?.sessionId) {
    const s = last.current;
    if (act === 'dismiss') {
      void chrome.runtime.sendMessage({ type: 'cp:feedback', id, sessionId: s.sessionId, feedback: 'dismissed' } satisfies ToBackground).then(refresh);
    } else if (act === 'accept') {
      const copy = s.actions.find((a) => a.kind === 'copy' && a.payload);
      if (copy?.payload) {
        void navigator.clipboard
          .writeText(copy.payload)
          .then(() => chrome.runtime.sendMessage({ type: 'cp:feedback', id, sessionId: s.sessionId, feedback: 'accepted' } satisfies ToBackground))
          .then(refresh);
      }
      else if (s.actions.some((a) => a.kind === 'handoff')) {
        // El traspaso lo ejecuta la pestaña (necesita el DOM de la conversación).
        void chrome.runtime.sendMessage({ type: 'cp:run-handoff', sessionId: s.sessionId, suggestionId: id } satisfies ToBackground);
      }
    }
  }
});

root.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const rule = t.dataset.rule;
  if (!rule) return;
  t.disabled = true;
  void chrome.runtime
    .sendMessage({ type: 'cp:set-rule', ruleId: rule, enabled: t.checked } satisfies ToBackground)
    .then((r: { ok: boolean }) => {
      if (!r?.ok) t.checked = !t.checked;
    })
    .finally(() => {
      t.disabled = false;
    });
});

chrome.runtime.onMessage.addListener((m: { type?: string }) => {
  if (m?.type === 'cp:state-changed') void refresh();
});
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') void refresh();
});

// Keepalive del service worker mientras el panel está abierto.
const port = chrome.runtime.connect({ name: 'cp-panel' });
setInterval(() => {
  try {
    port.postMessage({ type: 'ping' });
  } catch {
    /* SW reiniciado: el próximo refresh reabre */
  }
}, 20_000);
setInterval(() => void refresh(), 15_000);
void refresh();
