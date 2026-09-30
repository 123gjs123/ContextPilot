import type { ModelTier, Provider, WindowSource } from './types.js';

// Ventanas de contexto y nivel de modelo por familia. Valores por defecto; se matchea por regex
// sobre el id de modelo.

interface ModelInfo {
  match: RegExp;
  provider: Provider;
  contextWindow: number;
  tier: ModelTier;
  /** Tramos de precio por tamaño de prompt en tokens (G1). */
  priceTiers?: number[];
}

/** DECISIONS «ventanas»: Gemini 1 048 576 tokens. */
const GEMINI_WINDOW = 1_048_576;

const MODELS: ModelInfo[] = [
  { match: /\[1m\]/i, provider: 'anthropic', contextWindow: 1_000_000, tier: 'top' },
  { match: /opus|fable/i, provider: 'anthropic', contextWindow: 200_000, tier: 'top' },
  { match: /sonnet/i, provider: 'anthropic', contextWindow: 200_000, tier: 'mid' },
  { match: /haiku/i, provider: 'anthropic', contextWindow: 200_000, tier: 'small' },
  { match: /claude/i, provider: 'anthropic', contextWindow: 200_000, tier: 'mid' },
  { match: /gemini.*pro/i, provider: 'google', contextWindow: GEMINI_WINDOW, tier: 'top', priceTiers: [200_000] },
  { match: /gemini.*flash-lite/i, provider: 'google', contextWindow: GEMINI_WINDOW, tier: 'small' },
  { match: /gemini.*flash/i, provider: 'google', contextWindow: GEMINI_WINDOW, tier: 'mid' },
  { match: /gemini/i, provider: 'google', contextWindow: GEMINI_WINDOW, tier: 'mid' },
  { match: /mini|nano/i, provider: 'openai', contextWindow: 400_000, tier: 'small' },
  { match: /gpt-5|codex|(^|[^a-z])o\d/i, provider: 'openai', contextWindow: 400_000, tier: 'top' },
  { match: /gpt-4o|gpt-4\.1/i, provider: 'openai', contextWindow: 128_000, tier: 'mid' },
  { match: /gpt/i, provider: 'openai', contextWindow: 128_000, tier: 'mid' },
];

const DEFAULT_WINDOW: Record<Provider, number> = { anthropic: 200_000, openai: 128_000, google: GEMINI_WINDOW };

export function modelInfo(model: string, provider: Provider): ModelInfo {
  const hit = MODELS.find((m) => m.provider === provider && m.match.test(model));
  return hit ?? { match: /.*/, provider, contextWindow: DEFAULT_WINDOW[provider], tier: 'mid' };
}

export function contextWindowFor(model: string, provider: Provider): number {
  return modelInfo(model, provider).contextWindow;
}

/**
 * D-14 / CP-016.1: nivel del modelo. `overrides` (config `modelTiers`): id exacto primero; si no, el
 * fragmento más largo contenido en el id (sin distinguir mayúsculas); si no, la tabla.
 */
export function modelTier(model: string, provider: Provider, overrides?: Record<string, ModelTier>): ModelTier {
  if (overrides) {
    const exact = overrides[model];
    if (exact) return exact;
    const id = model.toLowerCase();
    let best: string | undefined;
    for (const k of Object.keys(overrides)) {
      if (k && id.includes(k.toLowerCase()) && (!best || k.length > best.length)) best = k;
    }
    if (best) return overrides[best]!;
  }
  return modelInfo(model, provider).tier;
}

export function isTopTier(model: string, provider: Provider, overrides?: Record<string, ModelTier>): boolean {
  return modelTier(model, provider, overrides) === 'top';
}

export function smallerModelFor(provider: Provider): string {
  return provider === 'anthropic' ? 'sonnet' : provider === 'openai' ? 'gpt-5-mini' : 'gemini-2.5-flash';
}

export function priceTiersFor(model: string, provider: Provider): number[] {
  return modelInfo(model, provider).priceTiers ?? [];
}

export interface ContextWindowInfo {
  window: number;
  source: WindowSource;
}

/**
 * DECISIONS «ventanas»: ventana de contexto con su origen.
 * - `overrides` (config `contextWindows`): match exacto de id de modelo → 'table' (declarada por el usuario).
 * - `reported`: ventana informada por la fuente (p. ej. Codex model_context_window) → 'observed'.
 * - `observedContext`: si el contexto observado supera la ventana nominal, se infiere 1M (Claude
 *   con 1M de contexto) o el doble de lo observado para otros proveedores → 'observed'.
 * - Modelo que matchea la tabla → 'table'; desconocido → default del proveedor con 'default'.
 */
export function contextWindowInfo(
  model: string,
  provider: Provider,
  opts: { overrides?: Record<string, number>; reported?: number; observedContext?: number } = {},
): ContextWindowInfo {
  const override = opts.overrides?.[model];
  let info: ContextWindowInfo;
  if (override && override > 0) info = { window: override, source: 'table' };
  else if (opts.reported && opts.reported > 0) info = { window: opts.reported, source: 'observed' };
  else {
    const hit = MODELS.find((m) => m.provider === provider && m.match.test(model));
    info = hit ? { window: hit.contextWindow, source: 'table' } : { window: DEFAULT_WINDOW[provider], source: 'default' };
  }
  const obs = opts.observedContext ?? 0;
  if (obs > info.window) {
    const window = provider === 'anthropic' && obs <= 1_000_000 ? 1_000_000 : Math.ceil(obs * 2);
    return { window, source: 'observed' };
  }
  return info;
}
