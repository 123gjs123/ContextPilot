import { EventEmitter } from 'node:events';
import {
  applyEvent,
  cacheRatio,
  contextWindowFor,
  isAccountSessionId,
  planWindows,
  R2,
  redact,
  RuleEngine,
  toView,
  ulid,
  type Feedback,
  type Provider,
  type SessionState,
  type SessionView,
  type Source,
  type Suggestion,
  type TurnEvent,
  type UsageWindow,
} from '@contextpilot/core';
import { adapterEnabled, type DaemonConfig } from './config.js';
import type { HealthRegistry } from './health.js';
import type { Logger } from './log.js';
import type { Storage } from './storage.js';

// CP-024: evento → applyEvent → RuleEngine.evaluate → persistir → difundir.
// Además: vencimiento de sugerencias (`suggestion-cleared` expired) y temporizador proactivo de R2
// (DECISIONS: la sugerencia debe estar visible antes de que el usuario vuelva a escribir).

export const ACTIVE_MS = 30 * 60_000;
const R2_MARGIN_MS = 1000;
const R2_STALE_MS = 30 * 60_000;
const R2_SOURCES: Source[] = ['claude-code', 'codex', 'gemini-cli', 'proxy'];
const USAGE_LOOKBACK_MS = 24 * 3_600_000;
const PROVIDERS: Provider[] = ['anthropic', 'openai', 'google'];
/** D-11: ventana del índice de adjuntos por sitio (CP-017.2). */
export const ATTACHMENT_WINDOW_MS = 7 * 86_400_000;
const ATTACHMENT_MAX_PER_HASH = 20;
const ATTACHMENT_SETTING = 'attachmentIndex';

/** Índice de adjuntos por sitio: sitio → hash → timestamps de subida (ms). Sólo hashes (RNF-01). */
export type AttachmentIndex = Record<string, Record<string, number[]>>;

export interface PipelineHooks {
  /** Serie exacta del proveedor para R10 (plan-usage de Claude Desktop), si hay. */
  planUsage?: (provider: string) => UsageWindow | undefined;
  /** D-2: foco de `/compact` calculado en memoria desde el transcript (nunca se persiste). */
  focusFor?: (sessionId: string) => string | undefined;
}

export type ClearedReason = Feedback | 'expired';

export interface IngestOptions {
  /**
   * Reprocesamiento al arrancar: sólo reconstruye estado. D-19: las reglas se evalúan en seco (sin
   * cooldowns, lugar visible ni publicación): antes, una R10 «disparada» en el pasado y descartada por
   * vencida dejaba el cooldown de la cuenta fijado y silenciaba la R10 real durante ~1 h.
   */
  replay?: boolean;
}

/** TurnEvent tal como llega por la API (id/ts opcionales, contenido opt-in). */
export type IncomingEvent = Partial<TurnEvent> & { content?: string };

export interface PipelineEvents {
  session: [SessionView];
  suggestion: [Suggestion];
  cleared: [{ id: string; sessionId: string; feedback?: ClearedReason }];
}

export class Pipeline extends EventEmitter<PipelineEvents> {
  private sessions = new Map<string, SessionState>();
  private visible = new Map<string, string>();
  private expiry = new Map<string, NodeJS.Timeout>();
  private r2Timers = new Map<string, NodeJS.Timeout>();
  /** D-18: pausa (lastTurnAt) en la que el temporizador ya emitió R2, por sesión. */
  private r2Fired = new Map<string, string>();
  /** D-2: versión decorada (con foco) de sugerencias publicadas; sólo memoria. */
  private decorated = new Map<string, Suggestion>();
  private attachments: AttachmentIndex;
  private disposed = false;
  private hooks: PipelineHooks;

  constructor(
    private storage: Storage,
    readonly engine: RuleEngine,
    private health: HealthRegistry,
    private getConfig: () => DaemonConfig,
    private log: Logger,
    hooks: PipelineHooks | PipelineHooks['planUsage'] = {},
  ) {
    super();
    this.hooks = typeof hooks === 'function' ? { planUsage: hooks } : hooks;
    this.attachments = storage.getSetting<AttachmentIndex>(ATTACHMENT_SETTING) ?? {};
    engine.loadDismissStreaks(storage.getSetting<Record<string, number>>('dismissStreaks') ?? {});
    const now = Date.now();
    for (const s of storage.loadSessions(now - USAGE_LOOKBACK_MS)) this.sessions.set(s.sessionId, s);
    for (const s of storage.openSuggestions(now)) {
      this.track(s);
      // La vigente persistida recupera su lugar visible y el cooldown en el motor (sin duplicarla).
      engine.restore(s, now);
    }
    for (const s of this.sessions.values()) this.scheduleR2(s);
  }

  // ---------- consultas ----------

  getSession(id: string): SessionState | undefined {
    let s = this.sessions.get(id);
    if (!s) {
      s = this.storage.loadSession(id);
      if (s) this.sessions.set(id, s);
    }
    return s;
  }

  activeViews(now = Date.now()): SessionView[] {
    return [...this.sessions.values()]
      .filter((s) => now - (Date.parse(s.lastTurnAt) || 0) < ACTIVE_MS)
      .sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt))
      .map((s) => toView(s));
  }

  allViews(): SessionView[] {
    const seen = new Map<string, SessionState>();
    for (const s of this.storage.listSessions()) seen.set(s.sessionId, s);
    for (const s of this.sessions.values()) seen.set(s.sessionId, s);
    return [...seen.values()].sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt)).map((s) => toView(s));
  }

  visibleFor(sessionId: string, now = Date.now()): Suggestion | undefined {
    const id = this.visible.get(sessionId);
    if (!id) return undefined;
    const s = this.storage.getSuggestion(id);
    if (!s || s.feedback || Date.parse(s.expiresAt) <= now) return undefined;
    return this.decorate(s);
  }

  activeSuggestions(now = Date.now()): Suggestion[] {
    return this.storage.listSuggestions({ active: true, now }).map((s) => this.decorate(s));
  }

  /** D-1: sugerencias de cuenta vigentes (una por proveedor, sessionId `account:<proveedor>`). */
  accountSuggestions(now = Date.now()): Suggestion[] {
    return this.activeSuggestions(now).filter((s) => isAccountSessionId(s.sessionId));
  }

  /** D-2: devuelve la versión con foco si existe (en memoria); si no, la persistida. */
  decorate<T extends Suggestion>(s: T): T {
    const d = this.decorated.get(s.id);
    return d ? { ...s, actions: d.actions } : s;
  }

  // ---------- ingesta ----------

  /** Aplica eventos en orden. Devuelve las sugerencias publicadas. */
  ingest(input: IncomingEvent[], opts: IngestOptions = {}): { accepted: number; suggestions: Suggestion[] } {
    const cfg = this.getConfig();
    const published: Suggestion[] = [];
    const touched = new Set<string>();
    let accepted = 0;
    for (const raw of input) {
      const e = this.normalize(raw);
      if (!adapterEnabled(cfg, e.source)) continue;
      if (!this.storage.insertTurn(e, (e.phase ?? 'response') === 'response' ? cacheRatio(e) : null)) continue;
      accepted++;
      if (raw.content && cfg.storeContent[e.source]) {
        this.storage.insertContent(e.sessionId, e.source, e.phase === 'prompt' ? 'user' : 'turn', redact(raw.content), Date.parse(e.ts));
      }
      const prev = this.getSession(e.sessionId);
      const state = applyEvent(prev, e);
      this.sessions.set(e.sessionId, state);
      touched.add(e.sessionId);
      if (e.source !== 'claude-code' && e.source !== 'codex' && e.source !== 'gemini-cli') this.health.seen(e.source, undefined, e.ts);

      const now = opts.replay ? Date.parse(e.ts) || Date.now() : Date.now();
      const siteAttachmentCounts = this.countAttachments(e, prev, now);
      // D-18: si el temporizador ya avisó R2 en esta pausa, el prompt que la cierra no lo repite.
      const phase = e.phase ?? 'response';
      const skipRules = phase === 'prompt' && prev && this.r2Fired.get(e.sessionId) === prev.lastTurnAt ? ['R2'] : undefined;
      if (phase === 'response') this.r2Fired.delete(e.sessionId);
      const out = this.engine.evaluate({
        event: e,
        prev,
        state,
        now,
        usageWindow: this.usageWindow(e),
        siteAttachmentCounts,
        skipRules,
        dryRun: opts.replay,
      });
      // D-19: en replay lo evaluado se descarta (el motor no fijó nada); se publica desde el vivo.
      if (opts.replay) continue;
      for (const s of out.published) published.push(this.publish(s, e.source));
      for (const s of out.refreshed ?? []) this.refresh(s);
    }
    for (const id of touched) {
      const s = this.sessions.get(id)!;
      this.storage.saveSession(s);
      this.emit('session', toView(s));
      this.scheduleR2(s);
    }
    return { accepted, suggestions: published };
  }

  private normalize(raw: IncomingEvent): TurnEvent {
    const { content: _content, ...rest } = raw;
    const e = structuredClone(rest) as TurnEvent;
    const tsMs = e.ts ? Date.parse(e.ts) : NaN;
    e.ts = Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : new Date().toISOString();
    e.id ||= ulid(Date.parse(e.ts));
    e.client ||= e.source;
    e.model ??= '';
    e.turn ??= 0;
    e.contextSize ??= 0;
    e.contextWindow ||= contextWindowFor(e.model, e.provider);
    e.promptHash ??= '';
    if (e.idleSincePrevMs === undefined) {
      const prev = this.getSession(e.sessionId);
      e.idleSincePrevMs = prev ? Math.max(0, Date.parse(e.ts) - Date.parse(prev.lastTurnAt)) : 0;
    }
    return e;
  }

  /**
   * D-11 (W2): registra las subidas del evento en el índice del sitio (7 días, todas las conversaciones)
   * y devuelve cuántas veces se subió cada hash. Se cuenta una vez por subida, como applyEvent.
   */
  private countAttachments(e: TurnEvent, prev: SessionState | undefined, now: number): Record<string, number> | undefined {
    if (!e.attachments?.length || (e.source !== 'web' && e.source !== 'desktop')) return undefined;
    const phase = e.phase ?? 'response';
    const isUpload = phase === 'prompt' || prev?.lastPhase !== 'prompt';
    const site = (this.attachments[e.client] ??= {});
    const from = now - ATTACHMENT_WINDOW_MS;
    const out: Record<string, number> = {};
    for (const a of e.attachments) {
      const list = (site[a.hash] ?? []).filter((t) => t >= from);
      if (isUpload) list.push(now);
      site[a.hash] = list.slice(-ATTACHMENT_MAX_PER_HASH);
      out[a.hash] = site[a.hash]!.length;
    }
    if (isUpload) this.persistAttachments(from);
    return out;
  }

  private persistAttachments(from: number): void {
    for (const [site, hashes] of Object.entries(this.attachments)) {
      for (const [h, list] of Object.entries(hashes)) {
        const keep = list.filter((t) => t >= from);
        if (keep.length) hashes[h] = keep;
        else delete hashes[h];
      }
      if (!Object.keys(hashes).length) delete this.attachments[site];
    }
    this.storage.setSetting(ATTACHMENT_SETTING, this.attachments);
  }

  private usageWindow(e: TurnEvent): UsageWindow | undefined {
    return this.usageWindowFor(e.provider, Date.parse(e.ts));
  }

  /** Serie de consumo del proveedor para R10 y /stats.burn (plan-usage exacto si hay; si no, turnos locales). */
  usageWindowFor(provider: Provider, nowMs = Date.now()): UsageWindow | undefined {
    const plan = this.engine.planFor(provider);
    if (!plan) return undefined;
    const exact = this.hooks.planUsage?.(provider);
    if (exact) return exact;
    const longest = Math.max(plan.windowMs ?? 0, ...planWindows(plan).map((w) => w.ms), USAGE_LOOKBACK_MS);
    return { provider, points: this.storage.usagePoints(provider, nowMs - longest) };
  }

  /**
   * D-22: reglas de cuenta (R10) sin depender de eventos de sesión: el daemon la llama cada 60 s, al
   * cambiar plan-usage y al terminar el escaneo inicial. Publica, renueva o retira la de cada proveedor.
   */
  evaluateAccounts(now = Date.now()): Suggestion[] {
    if (this.disposed) return [];
    const published: Suggestion[] = [];
    for (const provider of PROVIDERS) {
      if (!this.engine.planFor(provider)) continue;
      const out = this.engine.evaluateAccount({ provider, now, usageWindow: this.usageWindowFor(provider, now) });
      for (const s of out.published) published.push(this.publish(s));
      for (const s of out.refreshed) this.refresh(s);
      for (const s of out.cleared) this.clearResolved(s);
    }
    return published;
  }

  /** D-22: la sugerencia de cuenta sigue vigente: mismo id, vencimiento y texto nuevos; se re-difunde. */
  private refresh(s: Suggestion): void {
    if (!this.storage.refreshSuggestion(s)) return;
    this.untrack(s.id);
    this.track(s);
    this.emit('suggestion', s);
  }

  /** D-22: la proyección dejó de cumplirse: la sugerencia de cuenta se retira (como vencida). */
  private clearResolved(s: Suggestion): void {
    const cur = this.storage.getSuggestion(s.id);
    if (!cur || cur.feedback || (cur.status && cur.status !== 'open')) return;
    this.untrack(s.id);
    this.expire(s);
  }

  /** Publica y devuelve la versión que ven las UIs (con foco efímero si aplica). */
  private publish(s: Suggestion, source?: Source): Suggestion {
    const prevId = this.visible.get(s.sessionId);
    if (prevId && prevId !== s.id) {
      // RNF-13: la nueva (de mayor prioridad) reemplaza a la visible.
      this.storage.setStatus(prevId, 'superseded');
      this.untrack(prevId);
      this.emit('cleared', { id: prevId, sessionId: s.sessionId });
    }
    this.storage.insertSuggestion(s);
    this.track(s);
    const shown = this.withFocus(s, source);
    this.emit('suggestion', shown);
    return shown;
  }

  /**
   * D-2 / CP-010.1: R1 en Claude Code → `/compact <foco>` con archivos/herramientas de los últimos 5
   * prompts. El foco se calcula en memoria al publicar y NO se persiste (la fila guarda `/compact`).
   */
  private withFocus(s: Suggestion, source?: Source): Suggestion {
    if (s.ruleId !== 'R1' || source !== 'claude-code' || !this.hooks.focusFor) return s;
    let focus: string | undefined;
    try {
      focus = this.hooks.focusFor(s.sessionId);
    } catch {
      focus = undefined;
    }
    if (!focus) return s;
    const actions = s.actions.map((a) =>
      a.kind === 'copy' && a.payload === '/compact' ? { ...a, label: 'Copiar /compact con foco', payload: `/compact ${focus}` } : a,
    );
    const shown = { ...s, actions };
    this.decorated.set(s.id, shown);
    return shown;
  }

  private track(s: Suggestion): void {
    this.visible.set(s.sessionId, s.id);
    const delay = Math.max(0, Date.parse(s.expiresAt) - Date.now());
    const t = setTimeout(() => this.expire(s), delay);
    t.unref();
    this.expiry.set(s.id, t);
  }

  private untrack(id: string): void {
    const t = this.expiry.get(id);
    if (t) clearTimeout(t);
    this.expiry.delete(id);
    this.decorated.delete(id);
  }

  private expire(s: Suggestion): void {
    this.expiry.delete(s.id);
    if (this.disposed) return;
    const cur = this.storage.getSuggestion(s.id);
    if (!cur || cur.feedback || (cur.status && cur.status !== 'open')) return;
    this.storage.setStatus(s.id, 'expired');
    this.decorated.delete(s.id);
    if (this.visible.get(s.sessionId) === s.id) this.visible.delete(s.sessionId);
    this.emit('cleared', { id: s.id, sessionId: s.sessionId, feedback: 'expired' });
  }

  // ---------- feedback ----------

  feedback(id: string, fb: Feedback, surface?: string): boolean {
    const stored = this.storage.getSuggestion(id);
    if (!stored) return false;
    const known = this.engine.feedback(id, fb);
    if (!known && (fb === 'dismissed' || fb === 'accepted')) {
      // Sugerencia de antes de un reinicio: el motor no la conoce, se ajusta la racha a mano.
      const streaks = this.engine.getDismissStreaks();
      this.engine.loadDismissStreaks({ [stored.ruleId]: fb === 'accepted' ? 0 : (streaks[stored.ruleId] ?? 0) + 1 });
    }
    this.storage.setFeedback(id, fb, surface);
    this.storage.setSetting('dismissStreaks', this.engine.getDismissStreaks());
    this.untrack(id);
    if (this.visible.get(stored.sessionId) === id) this.visible.delete(stored.sessionId);
    this.emit('cleared', { id, sessionId: stored.sessionId, feedback: fb });
    return true;
  }

  // ---------- R2 proactivo ----------

  /** Programa la evaluación de R2 al cruzar el TTL de caché en una sesión inactiva con contexto grande. */
  scheduleR2(s: SessionState): void {
    const prevTimer = this.r2Timers.get(s.sessionId);
    if (prevTimer) clearTimeout(prevTimer);
    this.r2Timers.delete(s.sessionId);
    if (this.disposed) return;
    const cfg = this.getConfig();
    if (cfg.rules.R2?.enabled === false || !adapterEnabled(cfg, s.source)) return;
    if (!R2_SOURCES.includes(s.source) || s.estimated || s.lastPhase !== 'response') return;
    const min = this.engine.thresholdsFor(R2, s.provider).minTokens ?? 50_000;
    if (s.contextSize <= min) return;
    const last = Date.parse(s.lastTurnAt);
    if (!Number.isFinite(last)) return;
    const fireAt = last + s.cacheTtlMs + R2_MARGIN_MS;
    if (Date.now() > fireAt + R2_STALE_MS) return;
    const t = setTimeout(() => this.fireR2(s.sessionId, s.lastTurnAt), Math.max(0, fireAt - Date.now()));
    t.unref();
    this.r2Timers.set(s.sessionId, t);
  }

  private fireR2(sessionId: string, lastTurnAt: string): void {
    this.r2Timers.delete(sessionId);
    if (this.disposed) return;
    const s = this.sessions.get(sessionId);
    if (!s || s.lastTurnAt !== lastTurnAt || s.lastPhase !== 'response') return;
    const now = Date.now();
    // Evento sintético de fase 'prompt': no se persiste ni modifica el estado.
    const ev: TurnEvent = {
      id: ulid(now),
      source: s.source,
      provider: s.provider,
      client: s.client,
      sessionId,
      turn: s.turns,
      ts: new Date(now).toISOString(),
      model: s.model,
      tokens: { input: 0, output: 0, estimated: false },
      contextSize: s.contextSize,
      contextWindow: s.contextWindow,
      idleSincePrevMs: now - Date.parse(lastTurnAt),
      promptHash: '',
      phase: 'prompt',
    };
    const out = this.engine.evaluate({ event: ev, prev: s, state: s, now });
    for (const sug of out.published) this.publish(sug, s.source);
    if (out.published.some((x) => x.ruleId === 'R2')) {
      this.r2Fired.set(sessionId, lastTurnAt);
      this.log.info(`R2 proactivo: sesión ${sessionId}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.expiry.values()) clearTimeout(t);
    for (const t of this.r2Timers.values()) clearTimeout(t);
    this.expiry.clear();
    this.r2Timers.clear();
  }
}
