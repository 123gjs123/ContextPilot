import { R1, R2, R3, R5, R6, R7, R8, R9 } from './rules/cli.js';
import { G1, G2, R10, R4, W1, W2, W3, W4 } from './rules/other.js';
import type {
  Config,
  Feedback,
  PlanProfile,
  Provider,
  Rule,
  RuleThresholds,
  SessionState,
  Severity,
  Suggestion,
  TurnEvent,
} from './types.js';
import { estimateSaving } from './savings.js';
import { ulid } from './util.js';

export const ALL_RULES: Rule[] = [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, W1, W2, W3, W4, G1, G2];

const SEVERITY_RANK: Record<Severity, number> = { info: 1, warn: 2, critical: 3 };
const SUGGESTION_TTL_MS = 10 * 60_000;
const SNOOZE_MS = 15 * 60_000;
/** DECISIONS «subagentes»: las llamadas de subagentes sólo alimentan R5/R8 (y R10, ritmo). */
const SIDECHAIN_RULES = new Set(['R5', 'R8', 'R10']);

export function defaultConfig(rules: Rule[] = ALL_RULES): Config {
  return {
    rules: Object.fromEntries(
      rules.map((r) => [r.id, { enabled: true, thresholds: { ...r.defaults }, cooldownMs: r.defaultCooldownMs }]),
    ),
    providerOverrides: {},
    adapters: {},
    plans: [],
    storeContent: {},
    maxVisiblePerSession: 1,
  };
}

/** Mezcla profunda de configuración parcial sobre la default (para settings persistidos). */
export function mergeConfig(base: Config, patch: Partial<Config> | undefined): Config {
  if (!patch) return base;
  const out = structuredClone(base);
  for (const [id, r] of Object.entries(patch.rules ?? {})) {
    const cur = out.rules[id];
    if (!cur) continue;
    out.rules[id] = { ...cur, ...r, thresholds: { ...cur.thresholds, ...(r?.thresholds ?? {}) } };
  }
  if (patch.providerOverrides) out.providerOverrides = { ...out.providerOverrides, ...patch.providerOverrides };
  if (patch.adapters) out.adapters = { ...out.adapters, ...patch.adapters };
  if (patch.plans) out.plans = patch.plans;
  if (patch.storeContent) out.storeContent = { ...out.storeContent, ...patch.storeContent };
  if (patch.maxVisiblePerSession) out.maxVisiblePerSession = patch.maxVisiblePerSession;
  if (patch.contextWindows) out.contextWindows = { ...(out.contextWindows ?? {}), ...patch.contextWindows };
  return out;
}

export interface EvaluateInput {
  event: TurnEvent;
  prev?: SessionState;
  state: SessionState;
  now?: number;
  usageWindow?: { provider: Provider; points: { ts: number; tokens: number }[] };
}

export interface EvaluateOutput {
  /** Sugerencias nuevas a publicar (0 o 1 por sesión con maxVisiblePerSession=1). */
  published: Suggestion[];
  /** Reglas que dispararon pero quedaron agrupadas o suprimidas. */
  suppressed: { ruleId: string; reason: 'cooldown' | 'grouped' | 'visible' }[];
}

interface Visible {
  suggestion: Suggestion;
  priority: number;
  until: number;
}

/**
 * Motor de reglas (RF-REG-01..04). Mantiene cooldowns por (sesión, regla), la sugerencia visible
 * por sesión, y rachas de descarte por regla para bajar prioridad.
 */
export class RuleEngine {
  private cooldowns = new Map<string, number>();
  private visible = new Map<string, Visible>();
  private dismissStreak = new Map<string, number>();
  private byId = new Map<string, Suggestion>();

  constructor(
    public config: Config = defaultConfig(),
    private rules: Rule[] = ALL_RULES,
  ) {}

  setConfig(config: Config): void {
    this.config = config;
  }

  thresholdsFor(rule: Rule, provider: Provider): RuleThresholds {
    return {
      ...rule.defaults,
      ...(this.config.rules[rule.id]?.thresholds ?? {}),
      ...(this.config.providerOverrides[provider]?.[rule.id] ?? {}),
    };
  }

  planFor(provider: Provider): PlanProfile | undefined {
    return this.config.plans.find((p) => p.provider === provider);
  }

  /** Niveles de penalización por descartes: cada 3 descartes seguidos, uno más. */
  penalty(ruleId: string): number {
    return Math.floor((this.dismissStreak.get(ruleId) ?? 0) / 3);
  }

  /** RF-REG-04: cada nivel de penalización baja un escalón la severidad. */
  effectiveSeverity(ruleId: string, severity: Severity): { severity: Severity; quiet: boolean } {
    const rank = SEVERITY_RANK[severity] - this.penalty(ruleId);
    if (rank >= 3) return { severity: 'critical', quiet: false };
    if (rank === 2) return { severity: 'warn', quiet: false };
    return { severity: 'info', quiet: rank < 1 };
  }

  priority(ruleId: string, severity: Severity): number {
    return SEVERITY_RANK[this.effectiveSeverity(ruleId, severity).severity] * 100;
  }

  evaluate(input: EvaluateInput): EvaluateOutput {
    const { event, prev, state } = input;
    const now = input.now ?? Date.now();
    const phase = event.phase ?? 'response';
    const out: EvaluateOutput = { published: [], suppressed: [] };
    const fired: { rule: Rule; suggestion: Suggestion; priority: number }[] = [];

    for (const rule of this.rules) {
      const settings = this.config.rules[rule.id];
      if (settings && !settings.enabled) continue;
      if (!rule.on.includes(phase)) continue;
      if (!rule.sources.includes(event.source)) continue;
      if (event.sidechain && !SIDECHAIN_RULES.has(rule.id)) continue;
      if (rule.requiresExact && event.tokens.estimated && phase === 'response') continue;
      if (rule.requiresExact && state.estimated && phase === 'prompt') continue;
      const res = rule.evaluate({
        event,
        prev,
        state,
        thresholds: this.thresholdsFor(rule, event.provider),
        now,
        plan: this.planFor(event.provider),
        usageWindow: input.usageWindow,
      });
      if (!res) continue;
      const key = `${event.sessionId}:${rule.id}`;
      if ((this.cooldowns.get(key) ?? 0) > now) {
        out.suppressed.push({ ruleId: rule.id, reason: 'cooldown' });
        continue;
      }
      const eff = this.effectiveSeverity(rule.id, res.severity);
      const suggestion: Suggestion = {
        id: ulid(now),
        ruleId: rule.id,
        sessionId: event.sessionId,
        severity: eff.severity,
        quiet: eff.quiet || undefined,
        title: res.title,
        detail: res.detail,
        // CP-021: fórmula por regla (savings.ts); si no aplica, lo que informe la regla.
        estimatedSavingTokens: estimateSaving(rule.id, state, event) || res.estimatedSavingTokens,
        actions: res.actions,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + SUGGESTION_TTL_MS).toISOString(),
        estimated: event.tokens.estimated,
      };
      fired.push({ rule, suggestion, priority: this.priority(rule.id, res.severity) });
    }
    if (!fired.length) return out;

    // Decisión 27: mayor severidad; empate → mayor ahorro estimado.
    fired.sort(
      (a, b) =>
        b.priority - a.priority ||
        (b.suggestion.estimatedSavingTokens ?? 0) - (a.suggestion.estimatedSavingTokens ?? 0),
    );
    const top = fired[0]!;
    const rest = fired.slice(1);
    const cur = this.visible.get(event.sessionId);
    const curActive = cur && cur.until > now;

    if (curActive && cur.priority >= top.priority) {
      for (const f of fired) out.suppressed.push({ ruleId: f.rule.id, reason: 'visible' });
      return out;
    }

    top.suggestion.grouped = rest.map((f) => ({ ruleId: f.rule.id, title: f.suggestion.title }));
    for (const f of rest) out.suppressed.push({ ruleId: f.rule.id, reason: 'grouped' });
    for (const f of fired) {
      const base = this.config.rules[f.rule.id]?.cooldownMs ?? f.rule.defaultCooldownMs;
      const cd = base * 2 ** this.penalty(f.rule.id);
      this.cooldowns.set(`${event.sessionId}:${f.rule.id}`, now + cd);
    }
    this.visible.set(event.sessionId, { suggestion: top.suggestion, priority: top.priority, until: now + SUGGESTION_TTL_MS });
    this.byId.set(top.suggestion.id, top.suggestion);
    out.published.push(top.suggestion);
    return out;
  }

  /** RF-SUG-03 + RF-REG-04. Devuelve la sugerencia afectada si existe. */
  feedback(suggestionId: string, fb: Feedback, now = Date.now()): Suggestion | undefined {
    const s = this.byId.get(suggestionId);
    if (!s) return undefined;
    const v = this.visible.get(s.sessionId);
    if (v?.suggestion.id === suggestionId) this.visible.delete(s.sessionId);
    if (fb === 'dismissed') this.dismissStreak.set(s.ruleId, (this.dismissStreak.get(s.ruleId) ?? 0) + 1);
    if (fb === 'accepted') this.dismissStreak.set(s.ruleId, 0);
    if (fb === 'snoozed') this.cooldowns.set(`${s.sessionId}:${s.ruleId}`, now + SNOOZE_MS);
    return s;
  }

  visibleFor(sessionId: string, now = Date.now()): Suggestion | undefined {
    const v = this.visible.get(sessionId);
    return v && v.until > now ? v.suggestion : undefined;
  }

  getDismissStreaks(): Record<string, number> {
    return Object.fromEntries(this.dismissStreak);
  }

  loadDismissStreaks(s: Record<string, number>): void {
    for (const [k, v] of Object.entries(s)) this.dismissStreak.set(k, v);
  }

  get(id: string): Suggestion | undefined {
    return this.byId.get(id);
  }
}
