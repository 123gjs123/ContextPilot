// Lógica del content script ISOLATED. Sin dependencias de chrome.*: todo entra por `deps` para
// poder testearlo con jsdom. El entry (entries/content.ts) conecta chrome.runtime/storage.
import { estimateTokens, type Feedback, type Suggestion, type TurnEvent } from '@contextpilot/core';
import { readBridge, type NetDoneMsg, type NetStartMsg } from '../bridge.js';
import { DomTurnWatcher, type DomTurn } from '../capture/domTurns.js';
import { copyText, extractForHandoff, isPendingValid, waitAndPaste, type PendingHandoff } from '../handoff.js';
import type { CaptureMode, HandoffResponse, TabStatus, ToContent } from '../messages.js';
import { currentModel, detectExpensiveMode, readMessages, userMessageCount } from '../page.js';
import type { SiteDef } from '../sites.js';
import { buildTurnEvent, promptHashOf, sessionIdFor, type TurnCapture } from '../turnEvent.js';
import { Banner } from '../ui/banner.js';

export interface ControllerDeps {
  doc: Document;
  win: Window;
  site: SiteDef;
  nonce: string;
  sendEvents(events: TurnEvent[]): void;
  sendStatus(s: TabStatus): void;
  sendFeedback(id: string, sessionId: string, feedback: Feedback): void;
  requestHandoff(sessionId: string, content: string): Promise<HandoffResponse>;
  loadPending(): Promise<PendingHandoff | null>;
  savePending(p: PendingHandoff | null): Promise<void>;
  navigate(url: string): void;
  now?: () => number;
  /** Tiempo de gracia para que llegue la captura de red antes de usar la DOM (CP-040). */
  fallbackGraceMs?: number;
}

interface NetPending {
  start: NetStartMsg;
  priorText: string;
  userCount: number;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class ContentController {
  readonly banner: Banner;
  private watcher: DomTurnWatcher;
  private now: () => number;
  private net = new Map<string, NetPending>();
  private lastNetStartAt = 0;
  private lastDomTurnAt = 0;
  private domMisses = 0;
  private capture: CaptureMode;
  private health: TabStatus['health'] = 'ok';
  private healthDetail?: string;
  private sessionId: string | null = null;
  private prevTs = new Map<string, number>();
  private lastPromptHash = new Map<string, string>();
  private regenClickAt = 0;
  private pendingAttachments: { hash: string; tokens: number }[] = [];
  private urlTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage = (ev: MessageEvent): void => this.handleBridge(ev);

  constructor(private deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.capture = deps.site.primary === 'net' ? 'net' : 'dom';
    this.banner = new Banner(deps.doc, deps.site, {
      onAction: (s, a) => {
        if (a.kind === 'handoff') void this.startHandoff(s);
        else if (a.kind === 'copy' && a.payload) void this.copyAction(s, a.payload);
      },
      onDismiss: (s) => deps.sendFeedback(s.id, s.sessionId, 'dismissed'),
    });
    this.watcher = new DomTurnWatcher(deps.doc, deps.site, {
      now: this.now,
      onTurn: (t) => this.onDomTurn(t),
      onHealth: (status, detail) => {
        this.health = status;
        this.healthDetail = detail;
        this.reportStatus();
      },
    });
  }

  /** Suscripción al puente: debe correr en document_start para no perder el primer pedido. */
  listenBridge(): void {
    this.deps.win.addEventListener('message', this.onMessage);
  }

  /** Arranque DOM (con el documento ya cargado). */
  startDom(): void {
    const d = this.deps.doc;
    this.watcher.start();
    d.addEventListener('click', (e) => this.onClick(e), true);
    d.addEventListener('change', (e) => this.onFileInput(e), true);
    d.addEventListener('drop', (e) => this.onDataTransfer((e as DragEvent).dataTransfer), true);
    d.addEventListener('paste', (e) => this.onDataTransfer((e as ClipboardEvent).clipboardData), true);
    this.checkUrl();
    this.urlTimer = setInterval(() => {
      this.checkUrl();
      this.banner.ensureAttached();
    }, 1000);
    void this.resumeHandoff();
  }

  stop(): void {
    this.watcher.stop();
    this.deps.win.removeEventListener('message', this.onMessage);
    if (this.urlTimer) clearInterval(this.urlTimer);
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get captureMode(): CaptureMode {
    return this.capture;
  }

  // --- mensajes del service worker ---------------------------------------------------------

  handleRuntime(msg: ToContent): void {
    if (msg.type === 'cp:suggestion') {
      if (msg.suggestion.sessionId === this.sessionId) this.banner.show(msg.suggestion);
    } else if (msg.type === 'cp:suggestion-cleared') this.banner.clear(msg.id);
    else if (msg.type === 'cp:run-handoff' && msg.suggestion.sessionId === this.sessionId) void this.startHandoff(msg.suggestion);
  }

  // --- sesión / URL -------------------------------------------------------------------------

  private conversationId(): string | null {
    return this.deps.site.conversationIdFromPath(this.deps.win.location.pathname);
  }

  checkUrl(): void {
    const cid = this.conversationId();
    const sid = cid ? sessionIdFor(this.deps.site.id, cid) : null;
    if (sid !== this.sessionId) {
      this.sessionId = sid;
      if (this.banner.suggestion && this.banner.suggestion.sessionId !== sid) this.banner.hide();
      this.reportStatus();
    }
  }

  private reportStatus(): void {
    this.deps.sendStatus({
      site: this.deps.site.id,
      sessionId: this.sessionId,
      capture: this.capture,
      health: this.health,
      healthDetail: this.healthDetail,
    });
  }

  // --- captura de red (mundo MAIN) ----------------------------------------------------------

  private handleBridge(ev: MessageEvent): void {
    const msg = readBridge(ev, this.deps.win, this.deps.nonce);
    if (!msg) return;
    if (msg.kind === 'net-start') this.onNetStart(msg);
    else void this.onNetDone(msg);
  }

  onNetStart(msg: NetStartMsg): void {
    this.lastNetStartAt = this.now();
    this.watcher.arm();
    const msgs = safeMessages(this.deps.doc, this.deps.site);
    this.net.set(msg.reqId, {
      start: msg,
      priorText: msgs.map((m) => m.text).join('\n\n'),
      userCount: msgs.filter((m) => m.role === 'user').length,
    });
  }

  async onNetDone(msg: NetDoneMsg): Promise<void> {
    const p = this.net.get(msg.reqId);
    this.net.delete(msg.reqId);
    if (!p || !msg.text) return;
    if (this.capture !== 'net') {
      this.capture = 'net';
      this.reportStatus();
    }
    this.domMisses = 0;
    const cid = (await this.waitConversationId()) ?? p.start.conversationId ?? msg.conversationId;
    if (!cid) return;
    const doc = this.deps.doc;
    const domModel = currentModel(doc, this.deps.site);
    const model = msg.model || p.start.requestModel || domModel;
    const userNow = userMessageCount(doc, this.deps.site);
    // Al terminar, el prompt ya está renderizado: turno = mensajes de usuario visibles. Si los
    // selectores fallan (0), se usa el conteo de inicio (+1 si no es regeneración).
    const turn = userNow > 0 ? userNow : Math.max(1, p.userCount + (p.start.regenerated ? 0 : 1));
    this.emit({
      site: this.deps.site.id,
      conversationId: cid,
      turn,
      answerText: msg.text,
      reasoningText: msg.reasoningText,
      promptText: p.start.prompt,
      priorText: p.priorText,
      model,
      regenerated: p.start.regenerated,
      attachments: [...(p.start.attachments ?? [])],
      expensiveMode: p.start.expensiveMode ?? detectExpensiveMode(doc, this.deps.site, model),
      now: this.now(),
      via: 'net',
    });
  }

  /** chatgpt.com en chat nuevo: la URL /c/<id> aparece recién al terminar la respuesta. */
  private async waitConversationId(timeoutMs = 3000): Promise<string | null> {
    const start = this.now();
    let cid = this.conversationId();
    while (!cid && this.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
      cid = this.conversationId();
    }
    if (cid) this.checkUrl();
    return cid;
  }

  // --- captura DOM (Gemini primaria; claude/chatgpt respaldo) -----------------------------

  onDomTurn(t: DomTurn): void {
    if (this.deps.site.primary === 'dom') {
      this.emitDom(t);
      return;
    }
    // Respaldo: sólo si la red no cubrió este turno.
    const coveredByNet = (): boolean => this.lastNetStartAt > this.lastDomTurnAt || this.net.size > 0;
    const decide = (): void => {
      if (coveredByNet()) {
        this.lastDomTurnAt = this.now();
        return;
      }
      this.lastDomTurnAt = this.now();
      this.domMisses += 1;
      if (this.domMisses >= 2 && this.capture !== 'fallback-dom') {
        this.capture = 'fallback-dom';
        this.reportStatus();
      }
      this.emitDom(t);
    };
    if (coveredByNet()) decide();
    else setTimeout(decide, this.deps.fallbackGraceMs ?? 2000);
  }

  private emitDom(t: DomTurn): void {
    const cid = this.conversationId();
    if (!cid) return;
    const doc = this.deps.doc;
    const model = currentModel(doc, this.deps.site);
    this.emit({
      site: this.deps.site.id,
      conversationId: cid,
      turn: t.turn,
      answerText: t.answerText,
      promptText: t.promptText,
      priorText: t.priorText,
      model,
      expensiveMode: detectExpensiveMode(doc, this.deps.site, model),
      now: t.at,
      via: 'dom',
    });
  }

  private emit(c: TurnCapture): void {
    const sid = sessionIdFor(c.site, c.conversationId);
    const now = c.now;
    // Regeneración: clic en regenerar reciente o el mismo prompt reenviado.
    const ph = promptHashOf(c.promptText ?? '');
    const regenClick = this.regenClickAt > 0 && now - this.regenClickAt < 120_000;
    const samePrompt = !!ph && this.lastPromptHash.get(sid) === ph;
    c.regenerated = !!(c.regenerated || regenClick || samePrompt);
    this.regenClickAt = 0;
    c.prevTs = this.prevTs.get(sid);
    if (this.pendingAttachments.length) {
      c.attachments = [...(c.attachments ?? []), ...this.pendingAttachments];
      this.pendingAttachments = [];
    }
    const ev = buildTurnEvent(c);
    this.prevTs.set(sid, now);
    if (ph) this.lastPromptHash.set(sid, ph);
    this.deps.sendEvents([ev]);
  }

  // --- regenerar y adjuntos -----------------------------------------------------------------

  private onClick(e: Event): void {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== 'function') return;
    if (this.deps.site.selectors.regenerate.some((s) => safeClosest(t, s))) {
      this.regenClickAt = this.now();
      this.watcher.arm();
    }
  }

  private onFileInput(e: Event): void {
    const t = e.target as HTMLInputElement | null;
    if (t?.tagName === 'INPUT' && t.type === 'file' && t.files) void this.hashFiles(Array.from(t.files));
  }

  private onDataTransfer(dt: DataTransfer | null): void {
    if (dt?.files?.length) void this.hashFiles(Array.from(dt.files));
  }

  /** CP-040.3: SHA-256 del archivo en el content script; sólo hash + tokens estimados viajan. */
  async hashFiles(files: File[]): Promise<void> {
    for (const f of files) {
      try {
        this.pendingAttachments.push(await attachmentOf(f, this.deps.site.provider));
      } catch {
        /* archivo ilegible: se omite */
      }
    }
  }

  // --- acciones del banner ------------------------------------------------------------------

  private async copyAction(s: Suggestion, payload: string): Promise<void> {
    const ok = await copyText(this.deps.doc, payload);
    if (ok) {
      this.deps.sendFeedback(s.id, s.sessionId, 'accepted');
      this.banner.hide();
    } else this.banner.notice('no se pudo copiar al portapapeles');
  }

  async startHandoff(s: Suggestion): Promise<void> {
    const content = extractForHandoff(this.deps.doc, this.deps.site);
    if (!content) {
      this.banner.notice('no encontré texto de la conversación para resumir');
      return;
    }
    this.banner.notice('generando resumen de traspaso…');
    const res = await this.deps.requestHandoff(s.sessionId, content);
    if (!res.ok || !res.summary) {
      this.banner.notice(`no se pudo generar el resumen (${res.error ?? 'daemon no disponible'})`);
      return;
    }
    await copyText(this.deps.doc, res.summary); // respaldo si el pegado falla
    await this.deps.savePending({ site: this.deps.site.id, summary: res.summary, createdAt: this.now() });
    this.deps.sendFeedback(s.id, s.sessionId, 'accepted');
    this.banner.hide();
    this.deps.navigate(this.deps.site.newChatUrl);
  }

  /** En el chat nuevo: pega el traspaso pendiente sin enviar. */
  async resumeHandoff(): Promise<boolean> {
    const p = await this.deps.loadPending();
    if (!isPendingValid(p, this.deps.site.id, this.now())) return false;
    // Sólo en un chat nuevo (sin id de conversación).
    if (this.conversationId()) return false;
    await this.deps.savePending(null);
    return waitAndPaste(this.deps.doc, this.deps.site, p.summary);
  }
}

function safeMessages(doc: Document, site: SiteDef) {
  try {
    return readMessages(doc, site);
  } catch {
    return [];
  }
}

function safeClosest(el: Element, sel: string): boolean {
  try {
    return !!el.closest(sel);
  } catch {
    return false;
  }
}

export async function attachmentOf(f: File, provider: SiteDef['provider']): Promise<{ hash: string; tokens: number }> {
  let hashHex: string;
  if (f.size <= MAX_ATTACHMENT_BYTES) {
    const buf = await f.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    hashHex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    // Archivo enorme: identidad por metadatos (no se lee entero en memoria).
    const meta = new TextEncoder().encode(`${f.name}|${f.size}|${f.lastModified}`);
    const digest = await crypto.subtle.digest('SHA-256', meta);
    hashHex = 'meta:' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let tokens: number;
  if (/^text\/|json|xml|csv|javascript|typescript|markdown/i.test(f.type) && f.size < 2_000_000) {
    tokens = estimateTokens(await f.text(), provider);
  } else if (f.type.startsWith('image/')) tokens = 1600;
  else tokens = Math.round(f.size / 6); // PDF/binarios: aproximación gruesa
  return { hash: hashHex, tokens };
}
