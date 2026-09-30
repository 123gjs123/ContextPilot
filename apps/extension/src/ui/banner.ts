// Banner sobre el compositor (CP-048, RNF-13, SPEC §9).
// - Shadow DOM propio: los estilos del sitio no lo afectan y viceversa.
// - Se inserta en el flujo normal JUSTO ANTES del contenedor del compositor (hermano previo), con
//   position: static: ocupa su propia línea y nunca se superpone al cuadro de texto.
// - Una línea + máx. 2 botones: acción principal y «Ignorar». Nunca envía ni toca el compositor.
// - Sugerencias `quiet` no se muestran acá (sólo side panel).
import type { Suggestion, SuggestionAction } from '@contextpilot/core';
import { findComposer, findComposerContainer } from '../page.js';
import type { SiteDef } from '../sites.js';

export const BANNER_TAG = 'contextpilot-banner';

export interface BannerHandlers {
  onAction(s: Suggestion, action: SuggestionAction): void;
  onDismiss(s: Suggestion): void;
}

const CSS = `
:host { all: initial; display: block; position: static; box-sizing: border-box; width: 100%; margin: 0 0 6px 0; }
.bar { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 8px 4px 10px; box-sizing: border-box;
  font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; border-radius: 10px;
  background: #fff8e6; color: #3d2f00; border: 1px solid #f0d27a; }
.bar.info { background: #eef4ff; color: #14284b; border-color: #b9ccf2; }
.bar.critical { background: #fdecec; color: #5a1010; border-color: #f0a8a8; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .6; }
.msg { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button { flex: none; font: inherit; font-weight: 600; cursor: pointer; border-radius: 7px; padding: 3px 10px;
  border: 1px solid currentColor; background: transparent; color: inherit; }
button.primary { background: #1f2937; color: #fff; border-color: #1f2937; }
button:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
@media (prefers-color-scheme: dark) {
  .bar { background: #3a2f0b; color: #fbe7a7; border-color: #6b5716; }
  .bar.info { background: #14233f; color: #cfe0ff; border-color: #2c4677; }
  .bar.critical { background: #3f1414; color: #ffd0d0; border-color: #7a2a2a; }
  button.primary { background: #f3f4f6; color: #111827; border-color: #f3f4f6; }
}
`;

export class Banner {
  private host: HTMLElement | null = null;
  private current: Suggestion | null = null;
  private dismissed = new Set<string>();

  constructor(
    private doc: Document,
    private site: SiteDef,
    private handlers: BannerHandlers,
  ) {}

  get suggestion(): Suggestion | null {
    return this.current;
  }

  get element(): HTMLElement | null {
    return this.host;
  }

  /** Muestra (o reemplaza) la sugerencia. Devuelve false si no corresponde mostrarla. */
  show(s: Suggestion): boolean {
    if (s.quiet || this.dismissed.has(s.id) || Date.parse(s.expiresAt) < Date.now()) {
      if (this.current?.id === s.id) this.hide();
      return false;
    }
    this.current = s;
    return this.render();
  }

  hide(): void {
    this.current = null;
    this.host?.remove();
    this.host = null;
  }

  /** Reemplaza el texto de la línea (estado de una acción en curso o error). */
  notice(text: string): void {
    const msg = this.host?.shadowRoot?.querySelector('.msg');
    if (msg) msg.textContent = `ContextPilot: ${text}`;
  }

  /** Clear desde el daemon (suggestion-cleared). */
  clear(id: string): void {
    if (this.current?.id === id) this.hide();
  }

  /** Re-inserta si el sitio re-renderizó el compositor (SPA). */
  ensureAttached(): void {
    if (!this.current) return;
    if (!this.host?.isConnected || !this.isRightAboveComposer()) this.render();
  }

  private isRightAboveComposer(): boolean {
    const composer = findComposer(this.doc, this.site);
    if (!composer || !this.host) return false;
    return this.host.nextElementSibling === findComposerContainer(this.doc, this.site, composer);
  }

  private render(): boolean {
    const s = this.current;
    if (!s) return false;
    const composer = findComposer(this.doc, this.site);
    if (!composer) return false;
    const container = findComposerContainer(this.doc, this.site, composer);
    const parent = container.parentElement;
    if (!parent) return false;
    if (!this.host) {
      this.host = this.doc.createElement(BANNER_TAG);
      this.host.attachShadow({ mode: 'open' });
    }
    const root = this.host.shadowRoot!;
    root.innerHTML = '';
    const style = this.doc.createElement('style');
    style.textContent = CSS;
    const bar = this.doc.createElement('div');
    bar.className = `bar ${s.severity}`;
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    const dot = this.doc.createElement('span');
    dot.className = 'dot';
    const msg = this.doc.createElement('span');
    msg.className = 'msg';
    msg.textContent = lineFor(s);
    msg.title = s.detail || s.title;
    bar.append(dot, msg);

    const primary = primaryAction(s);
    if (primary) {
      const b = this.doc.createElement('button');
      b.type = 'button';
      b.className = 'primary';
      b.dataset.cp = 'primary';
      b.textContent = primary.kind === 'handoff' ? 'Generar resumen' : primary.label;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handlers.onAction(s, primary);
      });
      bar.append(b);
    }
    const dismiss = this.doc.createElement('button');
    dismiss.type = 'button';
    dismiss.dataset.cp = 'dismiss';
    dismiss.textContent = 'Ignorar';
    dismiss.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dismissed.add(s.id);
      this.hide();
      this.handlers.onDismiss(s);
    });
    bar.append(dismiss);
    root.append(style, bar);
    if (this.host.nextElementSibling !== container || this.host.parentElement !== parent) parent.insertBefore(this.host, container);
    return true;
  }
}

/** Acción principal: la primera de un clic que el banner sabe ejecutar. */
export function primaryAction(s: Suggestion): SuggestionAction | undefined {
  return s.actions.find((a) => a.kind === 'handoff') ?? s.actions.find((a) => a.kind === 'copy' && a.payload);
}

export function lineFor(s: Suggestion): string {
  const saving = s.estimatedSavingTokens ? ` · ahorro ≈${fmtK(s.estimatedSavingTokens)} tokens` : '';
  return `ContextPilot: ${s.title}${saving}`;
}

function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}
