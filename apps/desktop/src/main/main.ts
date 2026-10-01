import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Source } from '@contextpilot/core';
import { launchClaudeDesktop, ClaudeDesktopAdapter, type AdapterReport } from '../cdp/claudeDesktop.js';
import { handoffClipboardText, mcpToggleMessage, planAction } from '../shared/actions.js';
import { NotificationFilter, notificationContent } from '../shared/notify.js';
import { findSuggestion, initialState, markHandled, reduce, setConnection, type DesktopState } from '../shared/store.js';
import type { AppSnapshot, Feedback, HandoffResponse, PlanUsageView, ServerMsg, Suggestion, TrayColor } from '../shared/types.js';
import { accountRows, sessionRows, trayColor, trayMenuModel, trayTooltip } from '../shared/view.js';
import { ChatHost } from './chatHost.js';
import { findClaude, hooksInstalled, loggedIn, mcpConfigured } from './setupFacts.js';
import { setupItems } from '../shared/setup.js';
import { DaemonClient } from './daemonClient.js';
import { repoRootFrom, spawnDaemon } from './daemonSpawn.js';
import { trayPng } from './icon.js';
import { readPlanUsage } from './planUsageFile.js';
import { isAllowedApi, loadSettings, resolveHome, resolvePort } from './settings.js';

// Proceso principal: tray + overlay + dashboard + notificaciones. Cliente del daemon (HTTP + WS).
// La lógica vive en src/shared (pura, testeada); acá sólo se cablea Electron.

const SMOKE = process.argv.includes('--smoke');
/** --dashboard: abre la ventana del monitor al iniciar (además del tray). */
const OPEN_DASHBOARD = process.argv.includes('--dashboard');
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
/** Chat de ContextPilot: conversaciones manejadas por el `claude` CLI (pestaña «Chat»). */
const chats = new ChatHost({
  home,
  onUpdate: (s) => dashboard && !dashboard.isDestroyed() && dashboard.webContents.send('cp:chat', s),
  onList: (l) => dashboard && !dashboard.isDestroyed() && dashboard.webContents.send('cp:chatList', l),
});
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
  // Abre el dashboard en la sesión: la tarjeta está en rojo con la práctica recomendada.
  n.on('click', () => openDashboard(s.sessionId.startsWith('account:') ? undefined : s.sessionId));
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
      minWidth: 420,
      minHeight: 480,
      title: 'ContextPilot · Dashboard',
      backgroundColor: '#fcfcfb',
      autoHideMenuBar: true,
      webPreferences: webPreferences(),
    });
    // Links del chat (markdown): se abren en el navegador del sistema, nunca dentro de la app.
    dashboard.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    dashboard.webContents.on('will-navigate', (e) => e.preventDefault());
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
      // Sesión del chat de ContextPilot: los comandos (/compact, /clear, /model …) se ejecutan en ella.
      const chat = chats.bySession(s.sessionId);
      if (chat && plan.text.startsWith('/')) {
        const r = chats.send(chat.id, plan.text);
        if (r.ok) await sendFeedback(id, 'accepted');
        openDashboard(s.sessionId);
        return { ok: r.ok, message: r.ok ? `Ejecutado en el chat: ${plan.text.split(' ')[0]}` : r.message };
      }
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
    case 'mcp': {
      const r = await client.request<{ servers: string[] }>('POST', `/mcp/${plan.op}`, { sessionId: plan.sessionId, servers: plan.servers });
      if (!r.ok || !r.data) return { ok: false, message: `No se pudo ${plan.op === 'disable' ? 'desactivar' : 'reactivar'}: ${r.error ?? r.status}` };
      await sendFeedback(id, 'accepted');
      return { ok: true, message: mcpToggleMessage(plan.op, plan.servers, r.data.servers) };
    }
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
  // ---- Puesta en marcha ----
  ipcMain.handle('cp:setup', async (_e, force?: boolean) => {
    const bin = findClaude();
    const health = (n: string) => state.health.find((x) => x.name === n);
    return setupItems({
      claudeBin: bin,
      loggedIn: await loggedIn(bin, !!force),
      daemonConnected: state.connection === 'connected',
      hooksInstalled: hooksInstalled(),
      playwrightConfigured: mcpConfigured('playwright'),
      playwrightStatus: chats.mcpStatus('playwright'),
      desktopHealth: health('desktop'),
      webHealth: health('web'),
      repoRoot: repoRootFrom(OUT_DIR),
    });
  });
  ipcMain.handle('cp:copyText', (_e, text: string) => {
    clipboard.writeText(String(text).slice(0, 2000));
    return { ok: true, message: 'Copiado: pegalo en una terminal (PowerShell)' };
  });
  // ---- Chat ----
  ipcMain.handle('cp:chat:list', () => chats.list());
  ipcMain.handle('cp:chat:open', (_e, id: string) => chats.open(String(id)) ?? null);
  ipcMain.handle('cp:chat:create', async (e, model?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win!, { title: 'Carpeta de trabajo del chat', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const st = chats.create(r.filePaths[0], typeof model === 'string' && model ? model : undefined);
    return { state: st, list: chats.list() };
  });
  ipcMain.handle('cp:chat:send', (_e, id: string, text: string) => chats.send(String(id), String(text)));
  ipcMain.handle('cp:chat:interrupt', (_e, id: string) => chats.interrupt(String(id)));
  ipcMain.handle('cp:chat:permission', (_e, id: string, req: string, allow: boolean) => chats.permission(String(id), String(req), !!allow));
  ipcMain.handle('cp:chat:model', (_e, id: string, model: string) => chats.setModel(String(id), String(model ?? '')));
  ipcMain.handle('cp:chat:remove', (_e, id: string) => {
    chats.remove(String(id));
    return chats.list();
  });
}

function refreshPlanUsage(): void {
  try {
    planUsage = readPlanUsage();
  } catch {
    planUsage = undefined;
  }
}

async function main(): Promise<void> {
  if (SMOKE) {
    // CP-059: el smoke usa su propio userData (no choca con la instancia real abierta) y admite
    // tema/tamaño forzados para las capturas (light/dark, 1280×800 y ventana angosta).
    const ud = join(tmpdir(), `contextpilot-smoke-${process.pid}`);
    mkdirSync(ud, { recursive: true });
    app.setPath('userData', ud);
    const theme = process.env.CONTEXTPILOT_SMOKE_THEME;
    if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme;
  }
  if (!SMOKE && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId('ContextPilot');
  app.on('second-instance', (_e, argv) => (argv.includes('--dashboard') ? openDashboard() : showOverlay()));
  // App de bandeja: cerrar ventanas no termina el proceso.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => chats.stopAll());
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

  if (OPEN_DASHBOARD && !SMOKE) openDashboard();
  if (SMOKE) await smoke();
}

/**
 * --smoke: crea tray, overlay y dashboard, espera que carguen, imprime SMOKE_OK y sale.
 * --smoke-shot=<dir> captura overlay.png y dashboard.png; con CONTEXTPILOT_SMOKE_TABS (lista:
 * live, sessions, sessions-detail, stats, settings, settings-info, team) captura
 * `<prefijo>dashboard-<pestaña>.png` por cada una. CONTEXTPILOT_SMOKE_SIZE=1280x800 fija el tamaño
 * del contenido; CONTEXTPILOT_SMOKE_PREFIX antepone un prefijo a los archivos.
 */
async function smoke(): Promise<void> {
  const tabs = (process.env.CONTEXTPILOT_SMOKE_TABS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const fail = setTimeout(() => {
    console.log('SMOKE_FAIL timeout');
    app.exit(1);
  }, 20_000 + tabs.length * 5_000);
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
      const prefix = process.env.CONTEXTPILOT_SMOKE_PREFIX ?? '';
      const size = /^(\d+)x(\d+)$/.exec(process.env.CONTEXTPILOT_SMOKE_SIZE ?? '');
      if (size) dashboard!.setContentSize(Number(size[1]), Number(size[2]));
      await new Promise((r) => setTimeout(r, 1500));
      writeFileSync(join(dir, `${prefix}overlay.png`), (await overlay!.webContents.capturePage()).toPNG());
      writeFileSync(join(dir, `${prefix}dashboard.png`), (await dashboard!.webContents.capturePage()).toPNG());
      const js: Record<string, string> = {
        // CONTEXTPILOT_SMOKE_PICK: texto de la fila a abrir (default: la primera).
        'sessions-detail': `document.querySelector('[data-tab=sessions]').click(); setTimeout(() => { const rows = [...document.querySelectorAll('tbody tr.click')]; (rows.find((r) => r.textContent.includes(${JSON.stringify(process.env.CONTEXTPILOT_SMOKE_PICK ?? '')})) ?? rows[0])?.click(); }, 900);`,
        'settings-info': `document.querySelector('[data-tab=settings]').click(); setTimeout(() => document.querySelector('.info-btn')?.focus(), 900);`,
      };
      for (const t of tabs) {
        const full = t.endsWith('-full');
        const tab = full ? t.slice(0, -'-full'.length) : t;
        await dashboard!.webContents.executeJavaScript(js[tab] ?? `document.querySelector('[data-tab=${JSON.stringify(tab)}]')?.click();`);
        await new Promise((r) => setTimeout(r, 2200));
        const [w0, h0] = dashboard!.getContentSize() as [number, number];
        if (full) {
          // Página entera: alto del contenido (tope 4000 px) para ver todas las tarjetas.
          const hFull = await dashboard!.webContents.executeJavaScript(`document.getElementById('main').scrollHeight + document.querySelector('.tabs').offsetHeight + 4`);
          dashboard!.setContentSize(w0, Math.min(4000, Math.max(h0, Number(hFull) || h0)));
          await new Promise((r) => setTimeout(r, 900));
        }
        writeFileSync(join(dir, `${prefix}dashboard-${t}.png`), (await dashboard!.webContents.capturePage()).toPNG());
        if (full) dashboard!.setContentSize(w0, h0);
      }
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
