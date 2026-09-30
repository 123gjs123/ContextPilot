import type { Provider } from './types.js';

// Ventanas de contexto y nivel de modelo por familia. Valores por defecto; se matchea por regex
// sobre el id de modelo.

interface ModelInfo {
  match: RegExp;
  provider: Provider;
  contextWindow: number;
  tier: 'top' | 'mid' | 'small';
  /** Tramos de precio por tamaño de prompt en tokens (G1). */
  priceTiers?: number[];
}

const MODELS: ModelInfo[] = [
  { match: /\[1m\]/i, provider: 'anthropic', contextWindow: 1_000_000, tier: 'top' },
  { match: /opus|fable/i, provider: 'anthropic', contextWindow: 200_000, tier: 'top' },
  { match: /sonnet/i, provider: 'anthropic', contextWindow: 200_000, tier: 'mid' },
  { match: /haiku/i, provider: 'anthropic', contextWindow: 200_000, tier: 'small' },
  { match: /claude/i, provider: 'anthropic', contextWindow: 200_000, tier: 'mid' },
  { match: /gemini.*pro/i, provider: 'google', contextWindow: 1_000_000, tier: 'top', priceTiers: [200_000] },
  { match: /gemini.*flash-lite/i, provider: 'google', contextWindow: 1_000_000, tier: 'small' },
  { match: /gemini.*flash/i, provider: 'google', contextWindow: 1_000_000, tier: 'mid' },
  { match: /gemini/i, provider: 'google', contextWindow: 1_000_000, tier: 'mid' },
  { match: /mini|nano/i, provider: 'openai', contextWindow: 400_000, tier: 'small' },
  { match: /gpt-5|codex|(^|[^a-z])o\d/i, provider: 'openai', contextWindow: 400_000, tier: 'top' },
  { match: /gpt-4o|gpt-4\.1/i, provider: 'openai', contextWindow: 128_000, tier: 'mid' },
  { match: /gpt/i, provider: 'openai', contextWindow: 128_000, tier: 'mid' },
];

const DEFAULT_WINDOW: Record<Provider, number> = { anthropic: 200_000, openai: 128_000, google: 1_000_000 };

export function modelInfo(model: string, provider: Provider): ModelInfo {
  const hit = MODELS.find((m) => m.provider === provider && m.match.test(model));
  return hit ?? { match: /.*/, provider, contextWindow: DEFAULT_WINDOW[provider], tier: 'mid' };
}

export function contextWindowFor(model: string, provider: Provider): number {
  return modelInfo(model, provider).contextWindow;
}

export function isTopTier(model: string, provider: Provider): boolean {
  return modelInfo(model, provider).tier === 'top';
}

export function smallerModelFor(provider: Provider): string {
  return provider === 'anthropic' ? 'sonnet' : provider === 'openai' ? 'gpt-5-mini' : 'gemini-2.5-flash';
}

export function priceTiersFor(model: string, provider: Provider): number[] {
  return modelInfo(model, provider).priceTiers ?? [];
}
