// Contratos canónicos (SPEC §8). Todo adaptador emite TurnEvent; toda UI consume Suggestion y SessionView.

export type Source = 'claude-code' | 'codex' | 'gemini-cli' | 'proxy' | 'web' | 'desktop';
export type Provider = 'anthropic' | 'openai' | 'google';
export type Severity = 'info' | 'warn' | 'critical';

export interface TokenUsage {
  /** Tokens de entrada NO cacheados (Anthropic input_tokens; OpenAI/Gemini prompt - cached). */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  estimated: boolean;
}

export interface ToolCall {
  name: string;
  resultTokens: number;
  failed: boolean;
  argsHash: string;
}

export interface TurnEvent {
  id: string;
  source: Source;
  provider: Provider;
  client: string;
  sessionId: string;
  turn: number;
  ts: string;
  model: string;
  tokens: TokenUsage;
  /** Tokens en contexto tras el turno (prompt completo + salida). */
  contextSize: number;
  contextWindow: number;
  idleSincePrevMs: number;
  toolCalls?: ToolCall[];
  promptHash: string;
  promptEmbedding?: number[];
  attachments?: { hash: string; tokens: number }[];
  regenerated?: boolean;
  /**
   * Extensión (DECISIONS): 'prompt' = el usuario envió un prompt y aún no hay respuesta
   * (hooks UserPromptSubmit, extensión antes del stream). Por defecto 'response'.
   */
  phase?: 'prompt' | 'response';
  /** Extensión: tokens del prompt del usuario en este turno (para R7/W4). */
  promptTokens?: number;
  /** Extensión: herramientas/MCP disponibles en la sesión (R6). */
  toolsAvailable?: { name: string; definitionTokens: number }[];
  /** Extensión: TTL de caché observado para este turno (ms). */
  cacheTtlMs?: number;
  /** Extensión: modo caro activo en web (razonamiento extendido, deep research). */
  expensiveMode?: string;
  /** Extensión: bloques grandes enviados en el prompt (hash + tokens) para R9. */
  blocks?: { hash: string; tokens: number }[];
}

export type ActionKind = 'copy' | 'handoff' | 'open-session' | 'show-detail';

export interface SuggestionAction {
  kind: ActionKind;
  label: string;
  payload?: string;
}

export interface Suggestion {
  id: string;
  ruleId: string;
  sessionId: string;
  severity: Severity;
  title: string;
  detail: string;
  estimatedSavingTokens?: number;
  actions: SuggestionAction[];
  expiresAt: string;
  /** Extensión: ts de creación y sugerencias agrupadas detrás de ésta. */
  createdAt?: string;
  grouped?: { ruleId: string; title: string }[];
  estimated?: boolean;
  /** RF-REG-04: tras descartes repetidos de una regla info, sólo se muestra en side panel/dashboard. */
  quiet?: boolean;
}

export type Feedback = 'accepted' | 'dismissed' | 'snoozed';

export interface SessionState {
  sessionId: string;
  source: Source;
  provider: Provider;
  client: string;
  model: string;
  startedAt: string;
  lastTurnAt: string;
  /** Prompts del usuario (DECISIONS: turn = índice de prompt). */
  turns: number;
  /** Llamadas a la API (una por TurnEvent de respuesta). */
  calls: number;
  contextSize: number;
  contextWindow: number;
  estimated: boolean;
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  /** Historia reciente de proporción de caché (0..1), más nuevo al final. */
  cacheRatios: number[];
  cacheTtlMs: number;
  lastIdleMs: number;
  /** Últimas llamadas a herramientas (ventana acotada). */
  recentToolCalls: ToolCall[];
  toolsAvailable: { name: string; definitionTokens: number }[];
  toolLastUsedTurn: Record<string, number>;
  blockCounts: Record<string, { count: number; tokens: number }>;
  attachmentCounts: Record<string, number>;
  regenerations: number;
  /** Centroide de embeddings de prompts previos (R4). */
  centroid?: number[];
  centroidN: number;
  lastPromptTokens?: number;
  lastOutputTokens?: number;
  lastModel: string;
  lastPhase: 'prompt' | 'response';
  status: 'active' | 'idle' | 'closed';
}

export interface RuleThresholds {
  [key: string]: number;
}

export interface RuleSettings {
  enabled: boolean;
  thresholds: RuleThresholds;
  cooldownMs: number;
}

export interface PlanProfile {
  provider: Provider;
  kind: 'api' | 'subscription';
  /** Suscripción: tokens (o unidades) por ventana y duración de la ventana. */
  windowMs?: number;
  windowBudgetTokens?: number;
  /** API: presupuesto USD por día y precios por millón. */
  dailyBudgetUsd?: number;
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
}

export interface Config {
  rules: Record<string, RuleSettings>;
  /** Overrides de umbrales por proveedor: providerOverrides.google.R1.pct = 0.5 */
  providerOverrides: Partial<Record<Provider, Record<string, RuleThresholds>>>;
  adapters: Record<string, { enabled: boolean }>;
  plans: PlanProfile[];
  storeContent: Partial<Record<Source, boolean>>;
  maxVisiblePerSession: number;
}

export interface RuleContext {
  event: TurnEvent;
  state: SessionState;
  prev?: SessionState;
  thresholds: RuleThresholds;
  now: number;
  /** Historia de consumo agregada por proveedor (R10). */
  usageWindow?: { provider: Provider; points: { ts: number; tokens: number }[] };
  plan?: PlanProfile;
}

export interface RuleResult {
  severity: Severity;
  title: string;
  detail: string;
  estimatedSavingTokens?: number;
  actions: SuggestionAction[];
}

export interface Rule {
  id: string;
  phase: 0 | 1 | 2 | 3;
  sources: Source[];
  requiresExact: boolean;
  defaults: RuleThresholds;
  defaultCooldownMs: number;
  /** Se evalúa en 'prompt', 'response' o ambos. */
  on: ('prompt' | 'response')[];
  evaluate(ctx: RuleContext): RuleResult | null;
}

export interface AdapterHealth {
  name: string;
  status: 'ok' | 'no-data' | 'error' | 'disabled';
  lastEventAt?: string;
  detail?: string;
  formatVersion?: string;
}
