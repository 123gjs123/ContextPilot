import { recommendedSettings, type Config, type PlanProfile, type Provider, type Source } from '@contextpilot/core';

// Mapeo Config ↔ formulario de configuración (CP-054 UI, CP-055, CP-056). Puro.

export const PROVIDERS: Provider[] = ['anthropic', 'openai', 'google'];
export const SOURCES: Source[] = ['claude-code', 'codex', 'gemini-cli', 'proxy', 'web', 'desktop'];
export const KNOWN_ADAPTERS = ['claude-code', 'codex', 'gemini-cli', 'hooks', 'proxy', 'web', 'desktop'];

export const PROVIDER_LABEL: Record<Provider, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', google: 'Google (Gemini)' };

export interface RuleForm {
  id: string;
  enabled: boolean;
  cooldownMin: number;
  thresholds: { key: string; value: number }[];
}

export type PlanKind = 'none' | 'api' | 'subscription';

export interface PlanForm {
  provider: Provider;
  kind: PlanKind;
  dailyBudgetUsd: number | null;
  pricePerMTokIn: number | null;
  pricePerMTokOut: number | null;
  windowHours: number | null;
  windowBudgetTokens: number | null;
}

export interface ConfigForm {
  rules: RuleForm[];
  adapters: { name: string; enabled: boolean }[];
  plans: PlanForm[];
  storeContent: { source: Source; enabled: boolean }[];
}

function ruleOrder(id: string): [number, number] {
  const m = /^([A-Z])(\d+)$/.exec(id);
  const fam = { R: 0, W: 1, G: 2 }[m?.[1] ?? ''] ?? 3;
  return [fam, Number(m?.[2] ?? 0)];
}

export function configToForm(c: Config): ConfigForm {
  const rules = Object.entries(c.rules)
    .map(([id, r]) => ({
      id,
      enabled: r.enabled,
      cooldownMin: Math.round((r.cooldownMs / 60_000) * 100) / 100,
      thresholds: Object.entries(r.thresholds).map(([key, value]) => ({ key, value })),
    }))
    .sort((a, b) => {
      const [fa, na] = ruleOrder(a.id);
      const [fb, nb] = ruleOrder(b.id);
      return fa - fb || na - nb;
    });
  const adapterNames = [...new Set([...KNOWN_ADAPTERS, ...Object.keys(c.adapters)])];
  const adapters = adapterNames.map((name) => ({ name, enabled: c.adapters[name]?.enabled ?? true }));
  const plans = PROVIDERS.map((provider) => planToForm(provider, c.plans.find((p) => p.provider === provider)));
  const storeContent = SOURCES.map((source) => ({ source, enabled: c.storeContent[source] === true }));
  return { rules, adapters, plans, storeContent };
}

export function planToForm(provider: Provider, p: PlanProfile | undefined): PlanForm {
  return {
    provider,
    kind: p ? p.kind : 'none',
    dailyBudgetUsd: p?.dailyBudgetUsd ?? null,
    pricePerMTokIn: p?.pricePerMTokIn ?? null,
    pricePerMTokOut: p?.pricePerMTokOut ?? null,
    windowHours: p?.windowMs ? Math.round((p.windowMs / 3_600_000) * 100) / 100 : null,
    windowBudgetTokens: p?.windowBudgetTokens ?? null,
  };
}

export interface FormErrors {
  [field: string]: string;
}

function num(v: number | null | undefined): number | undefined {
  return v === null || v === undefined || !Number.isFinite(v) ? undefined : v;
}

/** Form → `Partial<Config>` para `PUT /config`. Valida y devuelve errores por campo. */
export function formToConfig(f: ConfigForm): { patch: Partial<Config>; errors: FormErrors } {
  const errors: FormErrors = {};
  const rules: Config['rules'] = {};
  for (const r of f.rules) {
    if (!Number.isFinite(r.cooldownMin) || r.cooldownMin < 0) errors[`rules.${r.id}.cooldown`] = 'Cooldown inválido';
    const thresholds: Record<string, number> = {};
    for (const t of r.thresholds) {
      if (!Number.isFinite(t.value) || t.value < 0) errors[`rules.${r.id}.${t.key}`] = 'Debe ser un número ≥ 0';
      thresholds[t.key] = t.value;
    }
    rules[r.id] = { enabled: r.enabled, thresholds, cooldownMs: Math.round(r.cooldownMin * 60_000) };
  }
  const adapters: Config['adapters'] = {};
  for (const a of f.adapters) adapters[a.name] = { enabled: a.enabled };
  const plans: PlanProfile[] = [];
  for (const p of f.plans) {
    if (p.kind === 'none') continue;
    if (p.kind === 'api') {
      const plan: PlanProfile = { provider: p.provider, kind: 'api' };
      const b = num(p.dailyBudgetUsd);
      const i = num(p.pricePerMTokIn);
      const o = num(p.pricePerMTokOut);
      if (b === undefined || b <= 0) errors[`plans.${p.provider}.dailyBudgetUsd`] = 'Presupuesto diario USD > 0';
      if (i !== undefined && i < 0) errors[`plans.${p.provider}.pricePerMTokIn`] = 'Precio ≥ 0';
      if (o !== undefined && o < 0) errors[`plans.${p.provider}.pricePerMTokOut`] = 'Precio ≥ 0';
      if (b !== undefined) plan.dailyBudgetUsd = b;
      if (i !== undefined) plan.pricePerMTokIn = i;
      if (o !== undefined) plan.pricePerMTokOut = o;
      plans.push(plan);
    } else {
      const h = num(p.windowHours);
      const t = num(p.windowBudgetTokens);
      if (h === undefined || h <= 0) errors[`plans.${p.provider}.windowHours`] = 'Ventana en horas > 0';
      if (t === undefined || t <= 0) errors[`plans.${p.provider}.windowBudgetTokens`] = 'Límite de tokens > 0';
      plans.push({ provider: p.provider, kind: 'subscription', windowMs: h ? Math.round(h * 3_600_000) : undefined, windowBudgetTokens: t });
    }
  }
  const storeContent: Config['storeContent'] = {};
  for (const s of f.storeContent) storeContent[s.source] = s.enabled;
  return { patch: { rules, adapters, plans, storeContent }, errors };
}

export interface PlanPreset {
  id: string;
  label: string;
  plan: PlanForm;
  /** CP-055.2: el proveedor no publica cifras exactas. */
  calibrate: boolean;
}

/** Presets editables (CP-055.2). Límites de suscripción «a calibrar»; precios API de referencia. */
export const PLAN_PRESETS: PlanPreset[] = [
  preset('claude-pro', 'Claude Pro (5 h)', 'anthropic', 'subscription', { windowHours: 5, windowBudgetTokens: 2_000_000 }),
  preset('claude-max5', 'Claude Max 5× (5 h)', 'anthropic', 'subscription', { windowHours: 5, windowBudgetTokens: 10_000_000 }),
  preset('claude-api', 'Anthropic API (Sonnet)', 'anthropic', 'api', { dailyBudgetUsd: 10, pricePerMTokIn: 3, pricePerMTokOut: 15 }),
  preset('chatgpt-plus', 'ChatGPT Plus (3 h)', 'openai', 'subscription', { windowHours: 3, windowBudgetTokens: 1_500_000 }),
  preset('openai-api', 'OpenAI API (GPT-5)', 'openai', 'api', { dailyBudgetUsd: 10, pricePerMTokIn: 1.25, pricePerMTokOut: 10 }),
  preset('gemini-pro', 'Gemini (24 h)', 'google', 'subscription', { windowHours: 24, windowBudgetTokens: 5_000_000 }),
  preset('gemini-api', 'Gemini API (2.5 Pro)', 'google', 'api', { dailyBudgetUsd: 10, pricePerMTokIn: 1.25, pricePerMTokOut: 10 }),
];

function preset(id: string, label: string, provider: Provider, kind: PlanKind, v: Partial<PlanForm>): PlanPreset {
  return {
    id,
    label,
    calibrate: true,
    plan: {
      provider,
      kind,
      dailyBudgetUsd: null,
      pricePerMTokIn: null,
      pricePerMTokOut: null,
      windowHours: null,
      windowBudgetTokens: null,
      ...v,
    },
  };
}

export interface ConfigChange {
  path: string;
  from: unknown;
  to: unknown;
}

/** Diff profundo para mostrar antes de importar (CP-056.2). */
export function diffConfig(a: unknown, b: unknown, base = ''): ConfigChange[] {
  if (Object.is(a, b)) return [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path: base || '(raíz)', from: a, to: b }];
  }
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffConfig(a[k], b[k], base ? `${base}.${k}` : k));
  }
  return [{ path: base || '(raíz)', from: a, to: b }];
}

/** Validación mínima de un JSON importado antes de mandarlo al daemon (el daemon valida en serio). */
export function looksLikeConfig(v: unknown): v is Partial<Config> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const cfg = (o.config && typeof o.config === 'object' ? o.config : o) as Record<string, unknown>;
  return 'rules' in cfg || 'adapters' in cfg || 'plans' in cfg;
}

/** CP-063: «Restaurar recomendado»: umbrales y cooldown por defecto de la regla (no toca «activa»). */
export function restoreRecommended(r: RuleForm): RuleForm {
  const rec = recommendedSettings(r.id);
  if (!rec) return r;
  return { ...r, cooldownMin: rec.cooldownMin, thresholds: Object.entries(rec.thresholds).map(([key, value]) => ({ key, value })) };
}

/** CP-063: la regla está en los valores recomendados. */
export function isRecommended(r: RuleForm): boolean {
  const rec = recommendedSettings(r.id);
  if (!rec) return true;
  if (Math.abs(r.cooldownMin - rec.cooldownMin) > 1e-9) return false;
  const cur = Object.fromEntries(r.thresholds.map((t) => [t.key, t.value]));
  return Object.entries(rec.thresholds).every(([k, v]) => cur[k] === v);
}
