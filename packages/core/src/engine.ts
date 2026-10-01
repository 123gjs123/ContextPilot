import { R1, R2, R3, R5, R6, R7, R8, R9, R11 } from './rules/cli.js';
import { G1, G2, R10, R4, W1, W2, W3, W4 } from './rules/other.js';
import { accountSessionId } from './actions.js';
import type {
  Config,
  Feedback,
  PlanProfile,
  Provider,
  Rule,
  RuleResult,
  RuleThresholds,
  SessionState,
  Severity,
  Suggestion,
  TurnEvent,
  UsageWindow,
} from './types.js';
import { estimateSaving } from './savings.js';
import { newSession } from './state.js';
import { ulid } from './util.js';

export const ALL_RULES: Rule[] = [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, W1, W2, W3, W4, G1, G2];

const SEVERITY_RANK: Record<Severity, number> = { info: 1, warn: 2, critical: 3 };
const SUGGESTION_TTL_MS = 10 * 60_000;
const SNOOZE_MS = 15 * 60_000;
/**
 * D-22: si la condición de una regla de cuenta deja de cumplirse, su sugerencia se retira y la regla
 * puede volver a publicar a lo sumo tras este margen (o antes, si su cooldown vencía antes): un ritmo
 * que oscila en el borde no re-notifica cada minuto.
 */
export const ACCOUNT_REARM_MS = 15 * 60_000;
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
  if (patch.modelTiers) out.modelTiers = { ...(out.modelTiers ?? {}), ...patch.modelTiers };
  return out;
}

export interface EvaluateInput {
  event: TurnEvent;
  prev?: SessionState;
  state: SessionState;
  now?: number;
  usageWindow?: UsageWindow;
  /** D-11: subidas por hash del adjunto en el sitio (7 días, todas las conversaciones). */
  siteAttachmentCounts?: Record<string, number>;
  /** Reglas a no evaluar en este evento (p. ej. R2 ya emitido por el temporizador para esta pausa). */
  skipRules?: string[];
  /**
   * D-19: evaluación en seco (replay de arranque): no fija cooldowns ni lugar visible ni registra la
   * sugerencia; `published`/`refreshed` informan lo que se habría publicado, para descartarlo.
   */
  dryRun?: boolean;
}

/** D-22: evaluación de las reglas de cuenta sin evento de sesión (temporizador, poll de plan-usage). */
export interface AccountEvaluateInput {
  provider: Provider;
  now?: number;
  usageWindow?: UsageWindow;
  dryRun?: boolean;
}

export interface EvaluateOutput {
  /**
   * Sugerencias nuevas a publicar: 0 o 1 de la sesión (maxVisiblePerSession=1) y, aparte, 0 o 1 de
   * cuenta por proveedor (D-1, sessionId `account:<proveedor>`).
   */
  published: Suggestion[];
  /** Reglas que dispararon pero quedaron agrupadas o suprimidas. */
  suppressed: { ruleId: string; reason: 'cooldown' | 'grouped' | 'visible' }[];
  /**
   * D-22: sugerencias de cuenta vigentes cuya condición sigue cumpliéndose: mismo id, vencimiento
   * renovado y título/detalle al día. Se re-difunden (las UIs reemplazan por id, sin notificar de nuevo).
   */
  refreshed?: Suggestion[];
}

export interface AccountEvaluateOutput extends EvaluateOutput {
  refreshed: Suggestion[];
  /** D-22: sugerencias de cuenta retiradas porque la proyección dejó de cumplirse. */
  cleared: Suggestion[];
}

interface Visible {
  suggestion: Suggestion;
  priority: number;
  until: number;
}

type Fired = { rule: Rule; suggestion: Suggestion; priority: number };

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

  /** Cooldown efectivo de la regla (base × 2^penalización). */
  cooldownFor(rule: Rule): number {
    const base = this.config.rules[rule.id]?.cooldownMs ?? rule.defaultCooldownMs;
    return base * 2 ** this.penalty(rule.id);
  }

  /**
   * Vida de la sugerencia: 10 min las de sesión. D-22: las de cuenta viven lo que su cooldown y se
   * renuevan mientras la condición se cumpla (antes: 10 min de cada 60 visibles en la statusline).
   */
  ttlFor(rule: Rule): number {
    return rule.scope === 'account' ? Math.max(SUGGESTION_TTL_MS, this.cooldownFor(rule)) : SUGGESTION_TTL_MS;
  }

  evaluate(input: EvaluateInput): EvaluateOutput {
    const { event, prev, state } = input;
    const now = input.now ?? Date.now();
    const phase = event.phase ?? 'response';
    const out: EvaluateOutput = { published: [], suppressed: [] };
    const fired: Fired[] = [];
    const account: Fired[] = [];
    const accountId = accountSessionId(event.provider);

    for (const rule of this.rules) {
      const settings = this.config.rules[rule.id];
      if (settings && !settings.enabled) continue;
      if (input.skipRules?.includes(rule.id)) continue;
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
        siteAttachmentCounts: input.siteAttachmentCounts,
        modelTiers: this.config.modelTiers,
      });
      if (!res) continue;
      const isAccount = rule.scope === 'account';
      const sid = isAccount ? accountId : event.sessionId;
      if (isAccount) {
        // D-22: la de cuenta vigente se renueva en lugar de quedar suprimida por su propio cooldown.
        const r = this.refreshAccount(rule, res, sid, now, input.dryRun);
        if (r === 'same') continue;
        if (r) {
          (out.refreshed ??= []).push(r);
          continue;
        }
      }
      if ((this.cooldowns.get(`${sid}:${rule.id}`) ?? 0) > now) {
        out.suppressed.push({ ruleId: rule.id, reason: 'cooldown' });
        continue;
      }
      const suggestion = this.build(rule, res, sid, event, state, now);
      (isAccount ? account : fired).push({ rule, suggestion, priority: this.priority(rule.id, res.severity) });
    }
    // D-1: las de cuenta compiten sólo entre sí, en su propio lugar visible por proveedor.
    if (account.length) this.select(account, accountId, now, out, input.dryRun);
    if (fired.length) this.select(fired, event.sessionId, now, out, input.dryRun);
    return out;
  }

  /**
   * D-22: evalúa las reglas `scope:'account'` del proveedor sin evento de sesión (el daemon la llama
   * cada 60 s y cuando cambia plan-usage). Publica si corresponde, renueva la vigente mientras la
   * condición se cumpla y la retira cuando deja de cumplirse (no por TTL fijo).
   */
  evaluateAccount(input: AccountEvaluateInput): AccountEvaluateOutput {
    const now = input.now ?? Date.now();
    const out: AccountEvaluateOutput = { published: [], suppressed: [], refreshed: [], cleared: [] };
    const slot = accountSessionId(input.provider);
    const account: Fired[] = [];
    const holding = new Set<string>();
    for (const rule of this.rules) {
      if (rule.scope !== 'account') continue;
      if (this.config.rules[rule.id]?.enabled === false) continue;
      // Evento y estado sintéticos: las reglas de cuenta sólo miran plan, serie y reloj.
      const event: TurnEvent = {
        id: ulid(now),
        source: rule.sources[0] ?? 'claude-code',
        provider: input.provider,
        client: 'account',
        sessionId: slot,
        turn: 0,
        ts: new Date(now).toISOString(),
        model: '',
        tokens: { input: 0, output: 0, estimated: false },
        contextSize: 0,
        contextWindow: 0,
        idleSincePrevMs: 0,
        promptHash: '',
      };
      const state = newSession(event);
      const res = rule.evaluate({
        event,
        state,
        thresholds: this.thresholdsFor(rule, input.provider),
        now,
        plan: this.planFor(input.provider),
        usageWindow: input.usageWindow,
      });
      if (!res) continue;
      holding.add(rule.id);
      const r = this.refreshAccount(rule, res, slot, now, input.dryRun);
      if (r === 'same') continue;
      if (r) {
        out.refreshed.push(r);
        continue;
      }
      if ((this.cooldowns.get(`${slot}:${rule.id}`) ?? 0) > now) {
        out.suppressed.push({ ruleId: rule.id, reason: 'cooldown' });
        continue;
      }
      account.push({ rule, suggestion: this.build(rule, res, slot, event, state, now), priority: this.priority(rule.id, res.severity) });
    }
    if (account.length) this.select(account, slot, now, out, input.dryRun);
    const cur = this.visible.get(slot);
    if (cur && cur.until > now && !holding.has(cur.suggestion.ruleId)) {
      out.cleared.push(cur.suggestion);
      if (!input.dryRun) {
        this.visible.delete(slot);
        const key = `${slot}:${cur.suggestion.ruleId}`;
        this.cooldowns.set(key, Math.min(this.cooldowns.get(key) ?? Infinity, now + ACCOUNT_REARM_MS));
      }
    }
    return out;
  }

  /**
   * Al reiniciar el daemon: la sugerencia abierta persistida vuelve a ocupar su lugar visible y el
   * cooldown de su regla se cuenta desde su creación (no se duplica ni se re-notifica).
   */
  restore(s: Suggestion, now = Date.now()): void {
    const until = Date.parse(s.expiresAt);
    if (!(until > now)) return;
    const rule = this.rules.find((r) => r.id === s.ruleId);
    const created = Date.parse(s.createdAt ?? '') || now;
    if (rule) {
      const key = `${s.sessionId}:${s.ruleId}`;
      this.cooldowns.set(key, Math.max(this.cooldowns.get(key) ?? 0, created + this.cooldownFor(rule)));
    }
    const cur = this.visible.get(s.sessionId);
    if (!cur || cur.until <= now || (Date.parse(cur.suggestion.createdAt ?? '') || 0) < created) {
      this.visible.set(s.sessionId, { suggestion: s, priority: this.priority(s.ruleId, s.severity), until });
    }
    this.byId.set(s.id, s);
  }

  private build(rule: Rule, res: RuleResult, sid: string, event: TurnEvent, state: SessionState, now: number): Suggestion {
    const eff = this.effectiveSeverity(rule.id, res.severity);
    return {
      id: ulid(now),
      ruleId: rule.id,
      sessionId: sid,
      severity: eff.severity,
      quiet: eff.quiet || undefined,
      title: res.title,
      detail: res.detail,
      // CP-021: fórmula por regla (savings.ts); si no aplica, lo que informe la regla.
      estimatedSavingTokens: estimateSaving(rule.id, state, event) || res.estimatedSavingTokens,
      actions: res.actions,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlFor(rule)).toISOString(),
      estimated: event.tokens.estimated,
    };
  }

  /**
   * D-22: si la regla de cuenta ya tiene su sugerencia vigente, la renueva (mismo id). Devuelve la
   * versión renovada si cambió el título o la severidad o si pasó la mitad de su vida (no se re-difunde
   * en cada evaluación: 'same'); `null` si no hay vigente de esa regla.
   */
  private refreshAccount(rule: Rule, res: RuleResult, slot: string, now: number, dryRun?: boolean): Suggestion | null | 'same' {
    const cur = this.visible.get(slot);
    if (!cur || cur.until <= now || cur.suggestion.ruleId !== rule.id) return null;
    const eff = this.effectiveSeverity(rule.id, res.severity);
    const ttl = this.ttlFor(rule);
    // El detalle (ritmo) cambia en cada evaluación; se re-difunde sólo si cambia el título (hh:mm) o la severidad.
    const changed = cur.suggestion.title !== res.title || cur.suggestion.severity !== eff.severity;
    if (!changed && cur.until - now > ttl / 2) return 'same';
    const next: Suggestion = {
      ...cur.suggestion,
      severity: eff.severity,
      quiet: eff.quiet || undefined,
      title: res.title,
      detail: res.detail,
      expiresAt: new Date(now + ttl).toISOString(),
    };
    if (!dryRun) {
      this.visible.set(slot, { suggestion: next, priority: this.priority(rule.id, res.severity), until: now + ttl });
      this.byId.set(next.id, next);
      // Tras un descarte, el cooldown cuenta desde la última vez que se vio vigente.
      this.cooldowns.set(`${slot}:${rule.id}`, now + this.cooldownFor(rule));
    }
    return next;
  }

  /** Elige la sugerencia visible de un «lugar» (sesión o cuenta), agrupa el resto y fija cooldowns. */
  private select(fired: Fired[], slot: string, now: number, out: EvaluateOutput, dryRun = false): void {
    // Decisión 27: mayor severidad; empate → mayor ahorro estimado.
    fired.sort(
      (a, b) =>
        b.priority - a.priority ||
        (b.suggestion.estimatedSavingTokens ?? 0) - (a.suggestion.estimatedSavingTokens ?? 0),
    );
    const top = fired[0]!;
    const rest = fired.slice(1);
    const cur = this.visible.get(slot);
    const curActive = cur && cur.until > now;

    // Misma regla de desempate que entre simultáneas (DECISIONS «una visible»): la vigente se queda
    // salvo que la nueva tenga mayor severidad, o igual severidad y mayor ahorro estimado (p. ej. R2
    // proactivo tras una pausa reemplaza a un R1 warn: la caché ya expiró y compactar dejó de ser lo mejor).
    const saving = (s: Suggestion) => s.estimatedSavingTokens ?? 0;
    if (curActive && (cur.priority > top.priority || (cur.priority === top.priority && saving(cur.suggestion) >= saving(top.suggestion)))) {
      for (const f of fired) out.suppressed.push({ ruleId: f.rule.id, reason: 'visible' });
      return;
    }

    top.suggestion.grouped = rest.map((f) => ({ ruleId: f.rule.id, title: f.suggestion.title }));
    for (const f of rest) out.suppressed.push({ ruleId: f.rule.id, reason: 'grouped' });
    out.published.push(top.suggestion);
    // D-19: en seco (replay de arranque) no queda nada fijado: ni cooldowns ni lugar visible.
    if (dryRun) return;
    for (const f of fired) this.cooldowns.set(`${slot}:${f.rule.id}`, now + this.cooldownFor(f.rule));
    this.visible.set(slot, { suggestion: top.suggestion, priority: top.priority, until: Date.parse(top.suggestion.expiresAt) });
    this.byId.set(top.suggestion.id, top.suggestion);
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
