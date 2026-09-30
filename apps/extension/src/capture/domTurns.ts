// Detector de turnos por DOM (CP-039 Gemini, CP-040 respaldo claude.ai/chatgpt.com).
// Un turno termina cuando la última respuesta del asistente deja de mutar durante `quietMs`
// (1,5 s por defecto) y no hay indicador de generación (botón de detener / aria-busy).
// Para no confundir la carga del historial con turnos nuevos, sólo se emite si el watcher está
// "armado": el usuario envió (Enter en el compositor o clic en enviar) o apareció el botón de detener.
import { lastAssistant, messageText, readMessages, isGenerating, userMessageCount } from '../page.js';
import { queryFirst, type SiteDef } from '../sites.js';

export interface DomTurn {
  answerText: string;
  promptText: string;
  priorText: string;
  turn: number;
  at: number;
}

export interface DomTurnWatcherOptions {
  quietMs?: number;
  /** Plazo para encontrar el contenedor antes de reportar health error. */
  containerTimeoutMs?: number;
  now?: () => number;
  onTurn(t: DomTurn): void;
  onHealth?(status: 'ok' | 'error', detail?: string): void;
}

const ARM_WINDOW_MS = 120_000;

export class DomTurnWatcher {
  private observer: MutationObserver | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private containerTimer: ReturnType<typeof setTimeout> | null = null;
  private emitted = new WeakMap<Element, string>();
  private armedAt = 0;
  private active: Element | null = null;
  private readonly quietMs: number;
  private readonly now: () => number;
  private listeners: [string, EventListener][] = [];

  constructor(
    private doc: Document,
    private site: SiteDef,
    private opts: DomTurnWatcherOptions,
  ) {
    this.quietMs = opts.quietMs ?? 1500;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    // Lo que ya está renderizado (historial) no es un turno nuevo.
    this.markExistingAsSeen();
    this.listen('keydown', (e) => {
      const k = e as KeyboardEvent;
      if (k.key === 'Enter' && !k.shiftKey && !k.isComposing && this.inComposer(k.target)) this.arm();
    });
    this.listen('click', (e) => {
      const t = e.target as Element | null;
      if (t && this.site.selectors.sendButton.some((s) => safeClosest(t, s))) this.arm();
    });
    this.attach();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.containerTimer) clearTimeout(this.containerTimer);
    for (const [t, l] of this.listeners) this.doc.removeEventListener(t, l, true);
    this.listeners = [];
  }

  /** Señal externa de envío (p. ej. el wrapper de red vio un pedido). */
  arm(): void {
    this.armedAt = this.now();
  }

  private listen(type: string, l: EventListener): void {
    this.doc.addEventListener(type, l, true);
    this.listeners.push([type, l]);
  }

  private inComposer(t: EventTarget | null): boolean {
    const el = t as Element | null;
    return !!el && typeof el.closest === 'function' && this.site.selectors.composer.some((s) => safeClosest(el, s));
  }

  private markExistingAsSeen(): void {
    for (const m of readMessages(this.doc, this.site)) if (m.role === 'assistant') this.emitted.set(m.el, m.text);
  }

  private attach(): void {
    const container = queryFirst(this.doc, this.site.selectors.conversation.filter((s) => s !== 'body'));
    if (!container) {
      // Reintenta; si no aparece en el plazo, health error (CP-039.2). Se observa body mientras tanto.
      if (!this.containerTimer) {
        this.containerTimer = setTimeout(() => {
          if (!queryFirst(this.doc, this.site.selectors.conversation.filter((s) => s !== 'body')))
            this.opts.onHealth?.('error', 'no se encontró el contenedor de la conversación');
        }, this.opts.containerTimeoutMs ?? 10_000);
      }
    } else this.opts.onHealth?.('ok');
    const target = container ?? this.doc.body;
    // MutationObserver de la ventana del documento (no el global): funciona igual en jsdom.
    const MO = this.doc.defaultView?.MutationObserver ?? MutationObserver;
    this.observer = new MO(() => this.onMutation());
    this.observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'class', 'aria-label', 'data-is-streaming'] });
  }

  private onMutation(): void {
    if (this.containerTimer && queryFirst(this.doc, this.site.selectors.conversation.filter((s) => s !== 'body'))) {
      clearTimeout(this.containerTimer);
      this.containerTimer = null;
      this.opts.onHealth?.('ok');
    }
    if (isGenerating(this.doc, this.site)) this.arm();
    const last = lastAssistant(this.doc, this.site);
    if (!last) return;
    const text = messageText(last);
    if (this.emitted.get(last) === text) return; // nada nuevo en la última respuesta
    if (!this.isArmed()) {
      // Cambio sin envío del usuario (carga de historial, re-render): se toma como visto.
      this.emitted.set(last, text);
      return;
    }
    this.active = last;
    this.scheduleQuiet();
  }

  private isArmed(): boolean {
    return this.armedAt > 0 && this.now() - this.armedAt < ARM_WINDOW_MS;
  }

  private scheduleQuiet(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.onQuiet(), this.quietMs);
  }

  private onQuiet(): void {
    this.quietTimer = null;
    const el = this.active;
    if (!el || !el.isConnected) return;
    if (isGenerating(this.doc, this.site)) {
      this.scheduleQuiet(); // sigue generando aunque no mute (p. ej. pensando)
      return;
    }
    const text = messageText(el);
    if (!text || this.emitted.get(el) === text) return;
    this.emitted.set(el, text);
    this.active = null;
    this.armedAt = 0;
    const msgs = readMessages(this.doc, this.site);
    const idx = msgs.findIndex((m) => m.el === el);
    const before = idx >= 0 ? msgs.slice(0, idx) : msgs.filter((m) => m.el !== el);
    const lastUser = [...before].reverse().find((m) => m.role === 'user');
    this.opts.onTurn({
      answerText: text,
      promptText: lastUser?.text ?? '',
      priorText: before.map((m) => m.text).join('\n\n'),
      turn: userMessageCount(this.doc, this.site),
      at: this.now(),
    });
  }
}

function safeClosest(el: Element, sel: string): boolean {
  try {
    return !!el.closest(sel);
  } catch {
    return false;
  }
}
