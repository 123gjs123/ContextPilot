// Definición centralizada de los sitios soportados: URLs de red, selectores DOM y URLs de chat nuevo.
// Todos los selectores del proyecto viven acá (CP-039.2 / CP-040): cuando un sitio cambia su DOM,
// sólo se toca este archivo. Cada lista es de fallbacks en orden de preferencia.
// Versión del set de selectores: subirla al cambiar cualquier selector (se reporta en health).
import type { Provider } from '@contextpilot/core';

export const SELECTORS_VERSION = '2026-09-30.1';

export type SiteId = 'claude.ai' | 'chatgpt.com' | 'gemini.google.com';
export type NetSiteId = Extract<SiteId, 'claude.ai' | 'chatgpt.com'>;

export interface SiteSelectors {
  /** Contenedor de la conversación a observar (MutationObserver). */
  conversation: string[];
  /** Cuadro de composición (textarea o contenteditable). */
  composer: string[];
  /** Contenedor visual del compositor: el banner se inserta justo antes (encima). */
  composerContainer: string[];
  sendButton: string[];
  /** Botón de detener: presente mientras el modelo genera. */
  stopButton: string[];
  /** Otros indicadores de generación en curso. */
  busy: string[];
  userMessage: string[];
  assistantMessage: string[];
  regenerate: string[];
  /** Etiqueta visible del modelo actual. */
  modelLabel: string[];
  /** Controles que indican un modo caro activo (razonamiento extendido, deep research). */
  expensiveMode: string[];
}

export interface SiteDef {
  id: SiteId;
  provider: Provider;
  hosts: string[];
  newChatUrl: string;
  /** Captura primaria: 'net' (wrapper de fetch) o 'dom' (MutationObserver). */
  primary: 'net' | 'dom';
  /** Extrae el id de conversación del pathname de la página. */
  conversationIdFromPath(pathname: string): string | null;
  /** Modelo por defecto cuando no se pudo detectar (sólo para elegir ventana de contexto). */
  defaultModel: string;
  /** Normaliza la etiqueta visible del modelo a un id comparable con la tabla de core. */
  normalizeModelLabel(label: string): string;
  /** Regex de modos caros sobre la etiqueta/modelo. */
  expensiveModelRe: RegExp;
  selectors: SiteSelectors;
}

export const SITES: Record<SiteId, SiteDef> = {
  'claude.ai': {
    id: 'claude.ai',
    provider: 'anthropic',
    hosts: ['claude.ai'],
    newChatUrl: 'https://claude.ai/new',
    primary: 'net',
    conversationIdFromPath: (p) => p.match(/\/chat\/([0-9a-f-]{8,})/i)?.[1] ?? null,
    defaultModel: 'claude',
    normalizeModelLabel: (l) => {
      const s = l.trim().toLowerCase().replace(/\s+/g, '-');
      return s.includes('claude') ? s : `claude-${s}`;
    },
    expensiveModelRe: /opus|research|extended/i,
    selectors: {
      conversation: ['[data-testid="conversation-turns"]', 'div.flex-1.flex.flex-col', 'main', 'body'],
      composer: [
        'div[contenteditable="true"].ProseMirror',
        '[data-testid="chat-input"][contenteditable="true"]',
        'fieldset div[contenteditable="true"]',
        'fieldset textarea',
        'textarea',
      ],
      composerContainer: ['fieldset', 'form', '[data-testid="chat-input-grid-container"]'],
      sendButton: ['button[aria-label="Send message"]', 'button[aria-label="Enviar mensaje"]', 'fieldset button[type="submit"]'],
      stopButton: ['button[aria-label="Stop response"]', 'button[aria-label="Detener respuesta"]', 'button[aria-label*="Stop"]'],
      busy: ['[data-is-streaming="true"]'],
      userMessage: ['[data-testid="user-message"]', '.font-user-message'],
      assistantMessage: ['.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]'],
      regenerate: [
        'button[data-testid="action-bar-retry"]',
        'button[aria-label="Retry"]',
        'button[aria-label="Reintentar"]',
        '[role="menuitem"][data-testid="retry"]',
      ],
      modelLabel: ['[data-testid="model-selector-dropdown"]', 'button[aria-label*="model" i] .whitespace-nowrap'],
      expensiveMode: [
        'button[aria-label*="Extended thinking"][aria-pressed="true"]',
        'button[aria-label*="Razonamiento extendido"][aria-pressed="true"]',
        'button[aria-label*="Research"][aria-pressed="true"]',
      ],
    },
  },
  'chatgpt.com': {
    id: 'chatgpt.com',
    provider: 'openai',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    newChatUrl: 'https://chatgpt.com/',
    primary: 'net',
    conversationIdFromPath: (p) => p.match(/\/c\/([0-9a-f-]{8,})/i)?.[1] ?? null,
    defaultModel: 'gpt-5',
    normalizeModelLabel: (l) => {
      const s = l.trim().toLowerCase().replace(/^chatgpt\s*/, '').replace(/\s+/g, '-');
      return s.startsWith('gpt') || /^o\d/.test(s) ? s : `gpt-${s}`;
    },
    expensiveModelRe: /thinking|(^|[^a-z])pro\b|deep[- ]?research|(^|[^a-z])o3\b/i,
    selectors: {
      conversation: ['main [class*="thread"]', 'main', 'body'],
      composer: ['#prompt-textarea', 'div[contenteditable="true"][data-virtualkeyboard]', 'form textarea', 'textarea'],
      composerContainer: ['form[data-type="unified-composer"]', 'form', '#composer-background'],
      sendButton: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label="Send prompt"]'],
      stopButton: ['button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label*="Detener"]'],
      busy: ['.result-streaming', '[data-message-author-role="assistant"] .streaming-animation'],
      userMessage: ['[data-message-author-role="user"]'],
      assistantMessage: ['[data-message-author-role="assistant"]'],
      regenerate: [
        'button[data-testid="regenerate-turn-action-button"]',
        'button[data-testid="regenerate-thread-error-button"]',
        'button[aria-label="Regenerate"]',
        'button[aria-label="Try again"]',
        'button[aria-label="Volver a generar"]',
        '[role="menuitem"][data-testid="regenerate"]',
      ],
      modelLabel: ['[data-testid="model-switcher-dropdown-button"]', 'button[aria-label*="Model selector" i]'],
      expensiveMode: ['button[data-testid="composer-button-deep-research"][aria-pressed="true"]', '[data-testid="system-hint-research"]'],
    },
  },
  'gemini.google.com': {
    id: 'gemini.google.com',
    provider: 'google',
    hosts: ['gemini.google.com'],
    newChatUrl: 'https://gemini.google.com/app',
    primary: 'dom',
    conversationIdFromPath: (p) => p.match(/\/app\/([0-9a-z_]{6,})/i)?.[1] ?? null,
    defaultModel: 'gemini',
    normalizeModelLabel: (l) => {
      const s = l.trim().toLowerCase().replace(/\s+/g, '-');
      return s.includes('gemini') ? s : `gemini-${s}`;
    },
    expensiveModelRe: /pro|deep[- ]?(think|research)/i,
    selectors: {
      conversation: ['#chat-history', 'infinite-scroller.chat-history', '.chat-history', 'chat-window', 'main', 'body'],
      composer: [
        'rich-textarea .ql-editor[contenteditable="true"]',
        'div.ql-editor[contenteditable="true"]',
        '[role="textbox"][contenteditable="true"]',
        'textarea',
      ],
      composerContainer: ['input-area-v2', '.input-area-container', 'input-container', 'form'],
      sendButton: ['button.send-button:not(.stop)', 'button[aria-label="Send message"]', 'button[aria-label="Enviar mensaje"]'],
      stopButton: ['button.send-button.stop', 'button[aria-label="Stop response"]', 'button[aria-label="Detener respuesta"]'],
      busy: ['model-response [aria-busy="true"]', 'pending-request', '.loading-indicator'],
      userMessage: ['user-query', '.user-query-container', '[data-test-id="user-query"]'],
      assistantMessage: ['model-response', '.model-response-container', '[data-test-id="model-response"]'],
      regenerate: [
        'button[aria-label*="Regenerate"]',
        'button[aria-label*="Volver a generar"]',
        'button[aria-label*="Redo"]',
        'button[mattooltip*="Regenerate"]',
      ],
      modelLabel: ['[data-test-id="bard-mode-menu-button"]', 'bard-mode-switcher button', '.logo-pill-label-container'],
      expensiveMode: ['deep-research-toggle [aria-pressed="true"]', 'button[aria-label*="Deep Research"][aria-pressed="true"]'],
    },
  },
};

export function siteForHost(hostname: string): SiteDef | null {
  const h = hostname.toLowerCase();
  for (const s of Object.values(SITES)) if (s.hosts.some((x) => h === x || h.endsWith('.' + x))) return s;
  return null;
}

/** Endpoints de conversación que se capturan por red (CP-038). */
export interface NetMatch {
  site: NetSiteId;
  /** claude.ai: retry_completion implica regeneración. */
  retry: boolean;
  /** Id de conversación si se deduce del path. */
  conversationId?: string;
}

const CLAUDE_COMPLETION = /\/api\/organizations\/[^/]+\/chat_conversations\/([^/?#]+)\/(retry_)?completion$/;
const CLAUDE_GENERIC = /^\/api\/.*\/(retry_)?completion$/;
const CHATGPT_CONVERSATION = /^\/backend-api\/(?:f\/)?conversation$/;

export function matchNetRequest(site: SiteId, method: string, url: URL): NetMatch | null {
  if (method.toUpperCase() !== 'POST') return null;
  if (site === 'claude.ai') {
    if (!siteForHost(url.hostname) || siteForHost(url.hostname)!.id !== 'claude.ai') return null;
    const m = url.pathname.match(CLAUDE_COMPLETION);
    if (m) return { site, retry: !!m[2], conversationId: m[1] };
    const g = url.pathname.match(CLAUDE_GENERIC);
    if (g) return { site, retry: !!g[1] };
    return null;
  }
  if (site === 'chatgpt.com') {
    if (siteForHost(url.hostname)?.id !== 'chatgpt.com') return null;
    return CHATGPT_CONVERSATION.test(url.pathname) ? { site, retry: false } : null;
  }
  return null;
}

// --- Helpers DOM con fallbacks -------------------------------------------------------------

export function queryFirst<T extends Element = HTMLElement>(root: ParentNode, sels: string[]): T | null {
  for (const s of sels) {
    try {
      const el = root.querySelector<T & Element>(s);
      if (el) return el as T;
    } catch {
      // selector inválido en este navegador: se ignora y se prueba el siguiente
    }
  }
  return null;
}

/** Todos los elementos que matchean el primer selector con resultados. */
export function queryAllFirst(root: ParentNode, sels: string[]): HTMLElement[] {
  for (const s of sels) {
    try {
      const els = Array.from(root.querySelectorAll<HTMLElement>(s));
      if (els.length) return els;
    } catch {
      /* siguiente */
    }
  }
  return [];
}

export function isVisible(el: Element | null): boolean {
  if (!el || !(el as HTMLElement).isConnected) return false;
  const h = el as HTMLElement;
  if (h.hidden || h.getAttribute('aria-hidden') === 'true') return false;
  const style = h.ownerDocument.defaultView?.getComputedStyle?.(h);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}
