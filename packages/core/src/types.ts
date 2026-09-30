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
  /** Extensión (D-13): ts de la llamada (lo completa applyEvent con el ts del evento). */
  ts?: string;
}

/** Herramienta/servidor MCP disponible en la sesión (R6). */
export interface AvailableTool {
  name: string;
  definitionTokens: number;
  /** true = costo estimado (Claude Code: nombres diferidos / instrucciones MCP), no la definición exacta. */
  estimated?: boolean;
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
  toolsAvailable?: AvailableTool[];
  /** Extensión (D-14): hash del system prompt del pedido (proxy), para el diff de R3. */
  systemHash?: string;
  /** Extensión: TTL de caché observado para este turno (ms). */
  cacheTtlMs?: number;
  /** Extensión: modo caro activo en web (razonamiento extendido, deep research). */
  expensiveMode?: string;
  /** Extensión: bloques grandes enviados en el prompt (hash + tokens) para R9. */
  blocks?: { hash: string; tokens: number }[];
  /**
   * Extensión (DECISIONS «subagentes»): llamada de un subagente / línea isSidechain atribuida a la
   * sesión padre. Suma a acumulados y toolCalls (R5/R8) pero no toca contextSize ni cacheRatios.
   */
  sidechain?: boolean;
  /** Extensión (DECISIONS «ventanas»): de dónde sale contextWindow. */
  windowSource?: WindowSource;
}

/**
 * 'table' = tabla de modelos; 'default' = modelo desconocido; 'observed' = informado por la fuente
 * (p. ej. model_context_window de Codex) o inferido porque el contexto observado superó la nominal.
 */
export type WindowSource = 'table' | 'default' | 'observed';

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
  toolsAvailable: AvailableTool[];
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
  /** Extensión: origen de contextWindow (DECISIONS «ventanas»). */
  windowSource?: WindowSource;
  /**
   * Extensión (D-5): muestras recientes de consumo para el ritmo de la sesión (≤ 60 min). D-21:
   * `tokens` = tokens efectivos (`effectiveTokens`); `raw` = suma sin ponderar (ausente en muestras viejas).
   */
  burnSamples?: { ts: number; tokens: number; raw?: number }[];
  /** Extensión (D-14): hash del system prompt (proxy) y llamada (`calls`) en que cambió por última vez. */
  systemHash?: string;
  systemChangedAtCall?: number;
  /** Extensión (D-14): llamada en que cambió el modelo por última vez y modelo anterior. */
  modelChangedAtCall?: number;
  modelBefore?: string;
}

export interface RuleThresholds {
  [key: string]: number;
}

export interface RuleSettings {
  enabled: boolean;
  thresholds: RuleThresholds;
  cooldownMs: number;
}

/** Ventana de un plan de suscripción (CP-055.1): `{hours: 5, limit}` o `{days: 7, limit}`. */
export interface PlanWindow {
  hours?: number;
  days?: number;
  /** Límite de la ventana en tokens (o unidades: % cuando la fuente es plan-usage de Claude Desktop). */
  limit: number;
}

export interface PlanProfile {
  provider: Provider;
  kind: 'api' | 'subscription';
  /** Suscripción: tokens (o unidades) por ventana y duración de la ventana. */
  windowMs?: number;
  windowBudgetTokens?: number;
  /** Suscripción (aditivo, D-15): varias ventanas (5 h + 7 días). Si está, se evalúan todas. */
  windows?: PlanWindow[];
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
  /** Extensión (DECISIONS «ventanas»): ventana declarada por id exacto de modelo. */
  contextWindows?: Record<string, number>;
  /**
   * Extensión (D-14 / CP-016.1): nivel de modelo declarado por el usuario. Clave = id exacto o
   * fragmento del id (sin distinguir mayúsculas; gana el más largo); pisa la tabla de `models.ts`.
   */
  modelTiers?: Record<string, ModelTier>;
}

/** Nivel de modelo (R7: «tarea simple en el modelo más caro» sólo evalúa `top`). */
export type ModelTier = 'top' | 'mid' | 'small';

export interface RuleContext {
  event: TurnEvent;
  state: SessionState;
  prev?: SessionState;
  thresholds: RuleThresholds;
  now: number;
  /** Historia de consumo agregada por proveedor (R10). */
  usageWindow?: UsageWindow;
  plan?: PlanProfile;
  /** D-11 (W2): subidas del mismo adjunto en el sitio (todas las conversaciones, 7 días), por hash. */
  siteAttachmentCounts?: Record<string, number>;
  /** D-14: overrides de nivel de modelo de la config. */
  modelTiers?: Record<string, ModelTier>;
}

/**
 * Serie de consumo por proveedor. `byWindow` (opcional) = serie propia por ventana del plan, con la
 * clave `<horas>h` (p. ej. plan-usage de Claude Desktop informa 5 h y 7 días por separado, en %).
 */
export interface UsageWindow {
  provider: Provider;
  points: { ts: number; tokens: number }[];
  byWindow?: Record<string, { ts: number; tokens: number }[]>;
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
  /**
   * D-1: 'account' = señal de cuenta (R10): una sugerencia por proveedor con cooldown y lugar visible
   * propios (sessionId `account:<proveedor>`), fuera del cupo por sesión. Default 'session'.
   */
  scope?: 'session' | 'account';
  evaluate(ctx: RuleContext): RuleResult | null;
}

export interface AdapterHealth {
  name: string;
  status: 'ok' | 'no-data' | 'error' | 'disabled';
  lastEventAt?: string;
  detail?: string;
  formatVersion?: string;
}
