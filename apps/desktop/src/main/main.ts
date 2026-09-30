import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, Tray } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Source } from '@contextpilot/core';
import { launchClaudeDesktop, ClaudeDesktopAdapter, type AdapterReport } from '../cdp/claudeDesktop.js';
import { handoffClipboardText, planAction } from '../shared/actions.js';
import { NotificationFilter, notificationContent } from '../shared/notify.js';
import { findSuggestion, initialState, markHandled, reduce, setConnection, type DesktopState } from '../shared/store.js';
import type { AppSnapshot, Feedback, HandoffResponse, PlanUsageView, ServerMsg, Suggestion, TrayColor } from '../shared/types.js';
import { accountRows, sessionRows, trayColor, trayMenuModel, trayTooltip } from '../shared/view.js';
import { DaemonClient } from './daemonClient.js';
import { repoRootFrom, spawnDaemon } from './daemonSpawn.js';
import { trayPng } from './icon.js';
import { readPlanUsage } from './planUsageFile.js';
import { isAllowedApi, loadSettings, resolveHome, resolvePort } from './settings.js';

// Proceso principal: tray + overlay + dashboard + notificaciones. Cliente del daemon (HTTP + WS).
// La lógica vive en src/shared (pura, testeada); acá sólo se cablea Electron.

const SMOKE = process.argv.includes('--smoke');
const OUT_DIR = __dirname;
const home = resolveHome();
const port = resolvePort();
const settings = loadSettings(home);

let state: DesktopState = initialState();
let planUsage: PlanUsageView | undefined;
let desktopReport: AdapterReport = { status: 'disabled', detail: 'Captura de Claude Desktop apagada' };
let tray: Tray | undefined;
let overlay: BrowserWindow | undefined;
let dashboard: BrowserWindow | undefined;
let lastColor: TrayColor | undefined;
let spawnedDaemon = false;
const notifier = new NotificationFilter();
let cdpAdapter: ClaudeDesktopAdapter | undefined;

const client = new DaemonClient(home, port, {
  onMessage: (m) => onServerMessage(m),
  onStatus: (s, err) => {
    // 'connected' sólo con 'hello' (lo pone reduce()).
    if (s === 'connected') return;
    if (state.connection === 'connected' && s === 'connecting') return;
    state = setConnection(state, s, err);
    publish();
  },
  onDown: (attempt) => {
    if (settings.spawnDaemon && !spawnedDaemon && attempt >= 1) {
      spawnedDaemon = true;
      const r = spawnDaemon(repoRootFrom(OUT_DIR), home, settings.daemonCommand);
      console.log(`[contextpilot] ${r.message}`);
    }
  },
});

function onServerMessage(m: ServerMsg): void {
  state = reduce(state, m);
  const now = Date.now();
  const incoming: Suggestion[] = m.type === 'hello' ? m.data.suggestions : m.type === 'suggestion' ? [m.data] : [];
  if (settings.notifications) for (const s of incoming) maybeNotify(s, now);
  publish();
}

function maybeNotify(s: Suggestion, now: number): void {
  if (!notifier.shouldNotify(s, now) || SMOKE || !Notification.isSupported()) return;
  const { title, body } = notificationContent(s);
  const n = new Notification({ title, body, urgency: 'critical' });
  n.on('click', () => {
    showOverlay();
    overlay?.webContents.send('cp:focusSuggestion', s.id);
  });
  n.show();
}

function snapshot(): AppSnapshot {
  const now = Date.now();
  return {
    connection: state.connection,
    lastError: state.lastError,
    sessions: sessionRows(state, now),
    account: accountRows(state, now),
    health: state.health,
    trayColor: trayColor(state, now),
    planUsage,
    desktopAdapter: { status: desktopReport.status, detail: desktopReport.detail },
  };
}

function publish(): void {
  const snap = snapshot();
  for (const w of [overlay, dashboard]) if (w && !w.isDestroyed()) w.webContents.send('cp:snapshot', snap);
  updateTray(snap.trayColor);
}

function updateTray(color: TrayColor): void {
  if (!tray) return;
  const now = Date.now();
  if (color !== lastColor) {
    const img = nativeImage.createFromBuffer(trayPng(color, 32), { scaleFactor: 2 });
    tray.setImage(img);
    lastColor = color;
  }
  tray.setToolTip(trayTooltip(state, now));
  const template = trayMenuModel(state, now).map((it) =>
    it.type === 'separator'
      ? { type: 'separator' as const }
      : { label: it.label, enabled: it.enabled ?? true, click: () => onMenu(it.id) },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function onMenu(id: string | undefined): void {
  if (!id) return;
  if (id === 'overlay') showOverlay();
  else if (id === 'dashboard') openDashboard();
  else if (id === 'quit') app.quit();
  else if (id === 'claude-desktop') void startClaudeDesktop();
  else if (id.startsWith('session:')) openDashboard(id.slice('session:'.length));
}

const webPreferences = () => ({
  preload: join(OUT_DIR, 'preload.cjs'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});

function createOverlay(): BrowserWindow {
  const w = new BrowserWindow({
    width: 380,
    height: 540,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#fcfcfb',
    webPreferences: webPreferences(),
  });
  w.loadFile(join(OUT_DIR, 'renderer', 'overlay.html'));
  w.on('blur', () => {
    if (!SMOKE && !w.webContents.isDevToolsOpened()) w.hide();
  });
  return w;
}

/** Ubica el overlay pegado al tray (abajo a la derecha en Windows 11). */
function showOverlay(): void {
  if (!overlay || overlay.isDestroyed()) overlay = createOverlay();
  const b = tray?.getBounds();
  const [w, h] = overlay.getSize() as [number, number];
  const display = b ? screen.getDisplayNearestPoint({ x: b.x, y: b.y }) : screen.getPrimaryDisplay();
  const wa = display.workArea;
  let x = b ? Math.round(b.x + b.width / 2 - w / 2) : wa.x + wa.width - w - 8;
  let y = b && b.y < wa.y + wa.height / 2 ? wa.y + 8 : wa.y + wa.height - h - 8;
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
  y = Math.max(wa.y + 8, y);
  overlay.setPosition(x, y, false);
  overlay.show();
  overlay.focus();
  overlay.webContents.send('cp:snapshot', snapshot());
}

function openDashboard(sessionId?: string): void {
  if (!dashboard || dashboard.isDestroyed()) {
    dashboard = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 720,
      minHeight: 520,
      title: 'ContextPilot · Dashboard',
      backgroundColor: '#fcfcfb',
      autoHideMenuBar: true,
      webPreferences: webPreferences(),
    });
    dashboard.loadFile(join(OUT_DIR, 'renderer', 'dashboard.html'), sessionId ? { hash: `session=${encodeURIComponent(sessionId)}` } : undefined);
  } else {
    if (sessionId) dashboard.webContents.send('cp:openSession', sessionId);
    dashboard.show();
    dashboard.focus();
  }
}

async function sendFeedback(id: string, feedback: Feedback): Promise<{ ok: boolean; message: string }> {
  const r = await client.request('POST', `/suggestions/${encodeURIComponent(id)}/feedback`, { feedback });
  if (!r.ok) return { ok: false, message: `No se pudo registrar el feedback: ${r.error ?? r.status}` };
  state = markHandled(state, id);
  publish();
  const txt = { accepted: 'Aceptada', dismissed: 'Ignorada', snoozed: 'Pospuesta 15 min' }[feedback];
  return { ok: true, message: txt };
}

async function runAction(id: string, index: number): Promise<{ ok: boolean; message: string }> {
  const s = findSuggestion(state, id);
  if (!s) return { ok: false, message: 'La sugerencia ya no está vigente' };
  const source = state.sessions[s.sessionId]?.source as Source | undefined;
  const plan = planAction(s, index, source);
  switch (plan.kind) {
    case 'copy': {
      clipboard.writeText(plan.text);
      const fb = await sendFeedback(id, plan.feedback);
      return { ok: true, message: fb.ok ? plan.message : `${plan.message} · ${fb.message}` };
    }
    case 'handoff': {
      const r = await client.request<HandoffResponse>('POST', '/handoff', { sessionId: plan.sessionId }, 90_000);
      if (!r.ok || !r.data?.summary) return { ok: false, message: `No se pudo generar el traspaso: ${r.error ?? 'respuesta vacía'}` };
      const { text, message } = handoffClipboardText(r.data, plan.source);
      clipboard.writeText(text);
      const fb = await sendFeedback(id, 'accepted');
      return { ok: true, message: fb.ok ? message : `${message} · ${fb.message}` };
    }
    case 'open-dashboard':
      openDashboard(plan.sessionId);
      if (plan.feedback) await sendFeedback(id, plan.feedback);
      return { ok: true, message: 'Abriendo sesión en el dashboard' };
    case 'show-detail':
      return { ok: true, message: plan.message };
    case 'error':
      return { ok: false, message: plan.message };
  }
}

async function startClaudeDesktop(): Promise<{ ok: boolean; message: string }> {
  const r = await launchClaudeDesktop(settings.cdpPort);
  ensureCdpAdapter();
  if (!r.ok && r.reason === 'refused') cdpAdapter!.markRefused(r.message);
  else if (r.ok) cdpAdapter!.start();
  if (!r.ok && Notification.isSupported() && !SMOKE) new Notification({ title: 'ContextPilot · Claude Desktop', body: r.message }).show();
  return { ok: r.ok, message: r.message };
}

function ensureCdpAdapter(): void {
  if (cdpAdapter) return;
  cdpAdapter = new ClaudeDesktopAdapter({
    port: settings.cdpPort,
    emit: async (events) => {
      const r = await client.request('POST', '/ingest/events', events);
      if (!r.ok) console.warn('[contextpilot] ingest desktop falló:', r.error);
    },
    onReport: (rep) => {
      desktopReport = rep;
      publish();
    },
  });
}

function registerIpc(): void {
  ipcMain.handle('cp:getSnapshot', () => snapshot());
  ipcMain.handle('cp:runAction', (_e, id: string, index: number) => runAction(String(id), Number(index)));
  ipcMain.handle('cp:feedback', (_e, id: string, fb: Feedback) => {
    if (!['accepted', 'dismissed', 'snoozed'].includes(fb)) return { ok: false, message: 'feedback inválido' };
    return sendFeedback(String(id), fb);
  });
  ipcMain.handle('cp:api', async (_e, method: string, path: string, body?: unknown) => {
    if (!isAllowedApi(method, path)) return { ok: false, status: 403, error: 'ruta no permitida' };
    return client.request(method, path, body, path === '/handoff' ? 90_000 : 15_000);
  });
  ipcMain.handle('cp:saveFile', async (e, defaultName: string, content: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const ext = String(defaultName).split('.').pop() ?? 'txt';
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: String(defaultName),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    writeFileSync(r.filePath, String(content), 'utf8');
    return { ok: true, path: r.filePath };
  });
  ipcMain.handle('cp:openJsonFiles', async (e, multi: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win!, {
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled) return [];
    return r.filePaths.map((p) => ({ name: p.split(/[\\/]/).pop() ?? p, content: readFileSync(p, 'utf8') }));
  });
  ipcMain.handle('cp:openDashboard', (_e, sessionId?: string) => openDashboard(sessionId));
  ipcMain.handle('cp:hideOverlay', () => overlay?.hide());
  ipcMain.handle('cp:launchClaudeDesktop', () => startClaudeDesktop());
}

function refreshPlanUsage(): void {
  try {
    planUsage = readPlanUsage();
  } catch {
    planUsage = undefined;
  }
}

async function main(): Promise<void> {
  if (!SMOKE && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId('ContextPilot');
  app.on('second-instance', () => showOverlay());
  // App de bandeja: cerrar ventanas no termina el proceso.
  app.on('window-all-closed', () => {});
  await app.whenReady();
  registerIpc();

  tray = new Tray(nativeImage.createFromBuffer(trayPng('gray', 32), { scaleFactor: 2 }));
  tray.on('click', () => (overlay?.isVisible() ? overlay.hide() : showOverlay()));
  overlay = createOverlay();
  refreshPlanUsage();
  publish();
  client.start();

  setInterval(() => {
    refreshPlanUsage();
    publish(); // vencimientos y ventana de «activa»
  }, 30_000).unref();

  if (settings.cdpAttachOnStart) {
    ensureCdpAdapter();
    cdpAdapter!.start();
  }

  if (SMOKE) await smoke();
}

/** --smoke: crea tray, overlay y dashboard, espera que carguen, imprime SMOKE_OK y sale. */
async function smoke(): Promise<void> {
  const fail = setTimeout(() => {
    console.log('SMOKE_FAIL timeout');
    app.exit(1);
  }, 15_000);
  const loaded = (w: BrowserWindow) =>
    new Promise<void>((res, rej) => {
      if (!w.webContents.isLoading()) return res();
      w.webContents.once('did-finish-load', () => res());
      w.webContents.once('did-fail-load', (_e, code, desc) => rej(new Error(`${code} ${desc}`)));
    });
  try {
    openDashboard(process.env.CONTEXTPILOT_SMOKE_SESSION);
    showOverlay();
    await Promise.all([loaded(overlay!), loaded(dashboard!)]);
    // El renderer confirma que su script corrió (window.cp disponible y primer render hecho).
    const probe =
      'new Promise((r) => { let i = 0; const t = setInterval(() => { const ok = document.body.dataset.ready === "1" && typeof window.cp === "object"; if (ok || ++i > 50) { clearInterval(t); r(ok); } }, 100); })';
    const [a, b] = await Promise.all([overlay!.webContents.executeJavaScript(probe), dashboard!.webContents.executeJavaScript(probe)]);
    if (!a || !b) throw new Error(`renderer no listo (overlay=${a}, dashboard=${b})`);
    // Da tiempo a que conecte con el daemon si está corriendo (no es requisito del smoke).
    for (let i = 0; i < 30 && state.connection !== 'connected'; i++) await new Promise((r) => setTimeout(r, 100));
    const shotArg = process.argv.find((x) => x.startsWith('--smoke-shot='));
    if (shotArg) {
      const dir = shotArg.slice('--smoke-shot='.length);
      await new Promise((r) => setTimeout(r, 1500));
      writeFileSync(join(dir, 'overlay.png'), (await overlay!.webContents.capturePage()).toPNG());
      writeFileSync(join(dir, 'dashboard.png'), (await dashboard!.webContents.capturePage()).toPNG());
    }
    clearTimeout(fail);
    console.log(`SMOKE_OK tray=${!!tray} overlay=${overlay!.isVisible()} dashboard=${!!dashboard} connection=${state.connection}`);
    client.stop();
    app.exit(0);
  } catch (e) {
    console.log('SMOKE_FAIL', e instanceof Error ? e.message : e);
    app.exit(1);
  }
}

void main();
