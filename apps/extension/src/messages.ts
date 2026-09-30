// Mensajes chrome.runtime entre content script, side panel, opciones y service worker.
import type { AdapterHealth, Config, Feedback, SessionView, Suggestion, TurnEvent } from '@contextpilot/core';
import type { SiteId } from './sites.js';

export type CaptureMode = 'net' | 'dom' | 'fallback-dom';

export interface TabStatus {
  site: SiteId;
  sessionId: string | null;
  capture: CaptureMode;
  /** Salud del adaptador del sitio en la pestaña (contenedor DOM encontrado, etc.). */
  health: 'ok' | 'error';
  healthDetail?: string;
}

export type ToBackground =
  | { type: 'cp:events'; events: TurnEvent[] }
  | { type: 'cp:tab-status'; status: TabStatus }
  | { type: 'cp:feedback'; id: string; sessionId: string; feedback: Feedback }
  | { type: 'cp:handoff'; sessionId: string; content: string }
  | { type: 'cp:run-handoff'; sessionId: string; suggestionId: string }
  | { type: 'cp:panel-state'; tabId?: number }
  | { type: 'cp:set-rule'; ruleId: string; enabled: boolean }
  | { type: 'cp:test-connection'; daemonUrl?: string; token?: string }
  | { type: 'cp:settings-changed' };

export type ToContent =
  | { type: 'cp:suggestion'; suggestion: Suggestion }
  | { type: 'cp:suggestion-cleared'; id: string }
  | { type: 'cp:run-handoff'; suggestion: Suggestion }
  | { type: 'cp:ping' };

export interface HandoffResponse {
  ok: boolean;
  summary?: string;
  error?: string;
}

export interface PanelState {
  daemon: 'up' | 'down' | 'unauthorized' | 'unconfigured';
  site: SiteId | null;
  tab: TabStatus | null;
  session: SessionView | null;
  current: Suggestion | null;
  history: (Suggestion & { feedback?: string })[];
  savings: { session: number; total: number | null };
  rules: { id: string; enabled: boolean; label: string }[];
  health: AdapterHealth[];
  queueSize: number;
  config?: Pick<Config, 'rules'>;
  /** D-1: aviso de cuenta del proveedor del sitio (R10), aparte de la sugerencia de la conversación. */
  account?: Suggestion | null;
}

export interface ConnectionTest {
  health: 'ok' | 'down';
  auth: 'ok' | 'unauthorized' | 'skipped' | 'error';
  detail?: string;
}
