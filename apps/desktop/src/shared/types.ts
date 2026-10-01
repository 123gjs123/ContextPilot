import type { AdapterHealth, Feedback, SessionView, Suggestion } from '@contextpilot/core';

// Tipos del contrato daemon ↔ desktop (docs/API.md). Sólo tipos: el desktop es cliente del daemon.

export type { AdapterHealth, Feedback, SessionView, Suggestion };

export type ClearedReason = Feedback | 'expired';

export type ServerMsg =
  | { type: 'hello'; data: { version: string; sessions: SessionView[]; suggestions: Suggestion[]; health: AdapterHealth[] } }
  | { type: 'session'; data: SessionView }
  | { type: 'suggestion'; data: Suggestion }
  | { type: 'suggestion-cleared'; data: { id: string; sessionId: string; feedback?: ClearedReason } }
  | { type: 'health'; data: AdapterHealth[] };

export type Connection = 'connecting' | 'connected' | 'unavailable';

export interface TimelinePoint {
  ts: string;
  contextSize: number;
  cacheRatio: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  estimated: boolean;
  /** CP-065: llamada de subagente (true), hilo principal (false) o desconocido (null: filas previas). */
  sidechain?: boolean | null;
}

export type SuggestionWithFeedback = Suggestion & { feedback?: ClearedReason };

export interface SessionDetail {
  view: SessionView;
  timeline: TimelinePoint[];
  suggestions: SuggestionWithFeedback[];
}

export interface StatsByRule {
  ruleId: string;
  fired: number;
  accepted: number;
  dismissed: number;
  snoozed: number;
  savedTokens: number;
}

export interface StatsByProvider {
  provider: string;
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  savedTokens: number;
}

export interface Stats {
  byRule: StatsByRule[];
  byProvider: StatsByProvider[];
  acceptanceRate: number;
  suggestionsPerActiveHour: number;
  /** Opcional (RNF-14): tokens consumidos por el propio asesor (traspasos con modelo). */
  advisorTokens?: number;
}

export interface HandoffResponse {
  summary: string;
  command?: string;
  method: 'claude-cli' | 'extractive';
}

/** API expuesta al renderer por el preload (contextBridge). */
export interface RendererApi {
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(cb: (s: AppSnapshot) => void): () => void;
  onFocusSuggestion(cb: (id: string) => void): () => void;
  runAction(suggestionId: string, actionIndex: number): Promise<{ ok: boolean; message: string }>;
  feedback(suggestionId: string, feedback: Feedback): Promise<{ ok: boolean; message: string }>;
  api<T = unknown>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: T; error?: string }>;
  saveFile(defaultName: string, content: string): Promise<{ ok: boolean; path?: string }>;
  openJsonFiles(multi: boolean): Promise<{ name: string; content: string }[]>;
  openDashboard(sessionId?: string): Promise<void>;
  hideOverlay(): Promise<void>;
  launchClaudeDesktop(): Promise<{ ok: boolean; message: string }>;
  chat: ChatApi;
}

/** Registro de un chat (sólo metadatos; el texto no se persiste). */
export interface ChatRecordView {
  id: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

type ChatResult = Promise<{ ok: boolean; message: string }>;

export interface ChatApi {
  list(): Promise<ChatRecordView[]>;
  open(id: string): Promise<import('./chat.js').ChatState | null>;
  create(model?: string): Promise<{ state: import('./chat.js').ChatState; list: ChatRecordView[] } | null>;
  send(id: string, text: string): ChatResult;
  interrupt(id: string): ChatResult;
  permission(id: string, requestId: string, allow: boolean): ChatResult;
  setModel(id: string, model: string): ChatResult;
  remove(id: string): Promise<ChatRecordView[]>;
  onUpdate(cb: (s: import('./chat.js').ChatState) => void): () => void;
  onList(cb: (l: ChatRecordView[]) => void): () => void;
}

/** D-1: aviso de cuenta por proveedor (R10), fuera de las sesiones. */
export interface AccountRow {
  provider: string;
  suggestion: SuggestionRow;
}

export interface AppSnapshot {
  connection: Connection;
  lastError?: string;
  sessions: SessionRow[];
  /** D-1: banner de cuenta (aditivo). */
  account?: AccountRow[];
  health: AdapterHealth[];
  trayColor: TrayColor;
  planUsage?: PlanUsageView;
  desktopAdapter: { status: AdapterHealth['status']; detail: string };
}

export type TrayColor = 'green' | 'yellow' | 'red' | 'gray';

export interface SessionRow {
  sessionId: string;
  /** CP-061: nombre legible («contextpilot — título»); el id corto va en `shortId`. */
  label: string;
  shortId: string;
  provider: string;
  source: string;
  model: string;
  /** «68%» o «≈45%» o «sin datos». */
  meterText: string;
  meterLevel: 'green' | 'yellow' | 'red' | 'none';
  contextPct: number | null;
  cacheText: string;
  noData: boolean;
  suggestion?: SuggestionRow;
  /** CP-059: vista completa (turnos, ritmo, última actividad, TTL) para las tarjetas «En vivo». */
  view: SessionView;
}

export interface SuggestionRow {
  id: string;
  ruleId: string;
  severity: Suggestion['severity'];
  title: string;
  detail: string;
  savingText?: string;
  estimatedSavingTokens?: number;
  /** `detail`: texto de las acciones `show-detail` (guía, ejemplo) para mostrarlo desplegado. */
  actions: { index: number; kind: string; label: string; detail?: string }[];
}

export interface PlanUsageView {
  fiveHourPct: number;
  sevenDayPct: number;
  sampledAt: string;
  stale: boolean;
}
