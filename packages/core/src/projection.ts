import type { PlanProfile, SessionState, TokenUsage } from './types.js';

// RF-EST-02 / CP-018 (D-5): ritmo de consumo y proyección de agotamiento contra las ventanas del plan.
// Puro: lo usan R10, el SessionView (`burn`), GET /stats y la evaluación de error por replay.

const MIN = 60_000;
const HOUR = 60 * MIN;
/** CP-018.1: media móvil de 15 min para el ritmo expuesto. */
export const BURN_WINDOW_MS = 15 * MIN;
/** Muestras que guarda la sesión para calcular su ritmo (una por llamada, ≤ 60 min). */
const BURN_KEEP_MS = 60 * MIN;
const BURN_MAX_SAMPLES = 120;

export interface Point {
  ts: number;
  tokens: number;
}

/**
 * D-21 (DECISIONS «ritmo»): peso de la lectura de caché en el ritmo. Mismo 0,1 que el ahorro
 * (`CACHE_READ_WEIGHT` de savings.ts; se repite acá para no importar savings desde projection).
 */
export const BURN_CACHE_READ_WEIGHT = 0.1;

/** D-21: tokens efectivos de una llamada = input + cacheWrite + output + 0,1 × cacheRead. */
export function effectiveTokens(t: Pick<TokenUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number {
  return t.input + (t.cacheWrite ?? 0) + t.output + BURN_CACHE_READ_WEIGHT * (t.cacheRead ?? 0);
}

/** D-21: suma cruda (sin ponderar), expuesta aparte como `rawTokensPerMin`. */
export function rawTokens(t: Pick<TokenUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number {
  return t.input + (t.cacheWrite ?? 0) + t.output + (t.cacheRead ?? 0);
}

export interface PlanWindowSpec {
  /** Clave estable: `<horas>h` (5h, 168h). */
  key: string;
  label: string;
  ms: number;
  budget: number;
}

/** Ventanas del plan: `windows` (5 h + 7 días) o el formato viejo `windowMs/windowBudgetTokens`. */
export function planWindows(plan: PlanProfile | undefined): PlanWindowSpec[] {
  if (!plan || plan.kind !== 'subscription') return [];
  const out: PlanWindowSpec[] = [];
  for (const w of plan.windows ?? []) {
    const ms = (w.hours ?? 0) * HOUR + (w.days ?? 0) * 24 * HOUR;
    if (ms > 0 && w.limit > 0) out.push(spec(ms, w.limit));
  }
  if (!out.length && plan.windowMs && plan.windowBudgetTokens) out.push(spec(plan.windowMs, plan.windowBudgetTokens));
  return out;
}

function spec(ms: number, budget: number): PlanWindowSpec {
  const hours = Math.round(ms / HOUR);
  const label = hours % 24 === 0 && hours >= 24 ? `${hours / 24} d` : `${hours} h`;
  return { key: `${hours}h`, label, ms, budget };
}

export interface Projection {
  window: string;
  label: string;
  /** Unidades usadas en la ventana actual y presupuesto. */
  used: number;
  budget: number;
  pct: number;
  /** Ritmo reciente medido (unidades por hora). */
  perHour: number;
  /**
   * D-5: ritmo con el que se proyecta (`perHour × rateFactor`): el uso real es a ráfagas y el ritmo
   * reciente sobreestima el resto de la ventana. Igual a `perHour` si no hay amortiguación.
   */
  projectedPerHour: number;
  windowEndsAt: number;
  /** Hora proyectada de agotamiento (ms) si ocurre antes del fin de la ventana. */
  exhaustAt?: number;
}

/**
 * D-5: factor de amortiguación del ritmo para proyectar (R10 `rateDamping`). Elegido sobre la primera
 * mitad de las ventanas reales de plan-usage (mínimo error sin perder ningún agotamiento real) y
 * validado en la segunda mitad: ver DECISIONS «proyección amortiguada» y `eval-projection.ts --holdout`.
 */
export const DEFAULT_RATE_DAMPING = 0.6;

/**
 * Proyección sobre una ventana: usado = suma de puntos desde `now − ms`; ritmo = suma de los últimos
 * `rateWindowMs` / duración; la ventana termina a `primer punto + ms`. D-5: el agotamiento se proyecta
 * con `ritmo × rateFactor` (1 = sin amortiguar).
 */
export function projectWindow(points: Point[], w: PlanWindowSpec, now: number, rateWindowMs = 60 * MIN, rateFactor = 1): Projection | null {
  const inWin = points.filter((p) => p.ts >= now - w.ms && p.ts <= now);
  if (!inWin.length) return null;
  const used = inWin.reduce((s, p) => s + p.tokens, 0);
  const recent = inWin.filter((p) => p.ts >= now - rateWindowMs).reduce((s, p) => s + p.tokens, 0);
  const measured = recent / rateWindowMs;
  const perMs = measured * rateFactor;
  const windowEndsAt = inWin[0]!.ts + w.ms;
  const remaining = w.budget - used;
  const out: Projection = {
    window: w.key,
    label: w.label,
    used,
    budget: w.budget,
    pct: used / w.budget,
    perHour: measured * HOUR,
    projectedPerHour: perMs * HOUR,
    windowEndsAt,
  };
  if (remaining <= 0) out.exhaustAt = now;
  else if (perMs > 0) {
    const at = now + remaining / perMs;
    if (at < windowEndsAt) out.exhaustAt = at;
  }
  return out;
}

/** Proyección de todas las ventanas del plan; `series(key)` da la serie propia de cada ventana si existe. */
export function projectPlan(
  plan: PlanProfile | undefined,
  series: (key: string) => Point[],
  now: number,
  rateWindowMs?: number,
  rateFactor?: number,
): Projection[] {
  const out: Projection[] = [];
  for (const w of planWindows(plan)) {
    const p = projectWindow(series(w.key), w, now, rateWindowMs, rateFactor);
    if (p) out.push(p);
  }
  return out;
}

// ---------- ritmo por sesión (SessionView.burn) ----------

/**
 * Agrega una muestra de consumo a la sesión y poda las viejas. D-21: `tokens` = efectivos de la
 * llamada; `raw` = suma cruda (si no se informa, igual a `tokens`).
 */
export function pushBurnSample(s: SessionState, ts: number, tokens: number, raw = tokens): void {
  if (!Number.isFinite(ts) || raw <= 0) return;
  const arr = (s.burnSamples ??= []);
  arr.push({ ts, tokens, raw });
  const from = ts - BURN_KEEP_MS;
  let i = 0;
  while (i < arr.length && arr[i]!.ts < from) i++;
  if (i) arr.splice(0, i);
  if (arr.length > BURN_MAX_SAMPLES) arr.splice(0, arr.length - BURN_MAX_SAMPLES);
}

export interface Burn {
  /** Tokens efectivos por minuto (D-21: input + cacheWrite + output + 0,1 × cacheRead), media móvil de 15 min (CP-018.1). */
  tokensPerMin: number;
  tokensPerHour: number;
  /** D-21: tokens por minuto sin ponderar (la lectura de caché pesa 1), para transparencia. */
  rawTokensPerMin: number;
  windowMin: number;
  estimated: boolean;
}

export function sessionBurn(s: SessionState, now = Date.now()): Burn {
  const from = now - BURN_WINDOW_MS;
  let sum = 0;
  let raw = 0;
  for (const p of s.burnSamples ?? []) {
    if (p.ts < from || p.ts > now) continue;
    sum += p.tokens;
    raw += p.raw ?? p.tokens;
  }
  const perMin = sum / (BURN_WINDOW_MS / MIN);
  return {
    tokensPerMin: Math.round(perMin),
    tokensPerHour: Math.round(perMin * 60),
    rawTokensPerMin: Math.round(raw / (BURN_WINDOW_MS / MIN)),
    windowMin: 15,
    estimated: s.estimated,
  };
}

// ---------- evaluación de la proyección por replay (CP-018.3) ----------

export interface PctSample {
  t: number;
  /** % usado de la ventana (0..100), p. ej. `fh` de plan-usage-history.json. */
  pct: number;
}

export interface ProjectionCase {
  windowStart: number;
  checkpointH: number;
  projectedPct: number;
  actualPct: number;
  /** |proyectado − real| en fracción del presupuesto (equivale a |ΔT| / duración con ritmo constante). */
  error: number;
}

export interface ProjectionEval {
  method: string;
  windows: number;
  cases: ProjectionCase[];
  meanError: number;
  p90Error: number;
  maxError: number;
  /** Fracción de casos con error < 20 %. */
  within20: number;
}

/**
 * Parte la serie en ventanas: una ventana empieza en la primera muestra con % > 0 tras una
 * renovación (el % cae) o tras `windowMs` desde el inicio anterior. Sólo cuentan ventanas con
 * cobertura hasta su final (hay una muestra a ≤ `maxGapMs` del fin o la ventana terminó en renovación).
 */
export function splitWindows(samples: PctSample[], windowMs: number, maxGapMs = 40 * MIN): { start: number; samples: PctSample[]; complete: boolean }[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const out: { start: number; samples: PctSample[]; complete: boolean }[] = [];
  let cur: { start: number; samples: PctSample[]; complete: boolean } | null = null;
  for (const s of sorted) {
    const prev = cur?.samples.at(-1);
    const reset = !!prev && s.pct < prev.pct - 0.5;
    const expired = !!cur && s.t >= cur.start + windowMs;
    if (cur && (reset || expired)) {
      cur.complete = reset || cur.samples.at(-1)!.t >= cur.start + windowMs - maxGapMs;
      out.push(cur);
      cur = null;
    }
    if (!cur) {
      if (s.pct <= 0) continue;
      cur = { start: s.t, samples: [], complete: false };
    }
    cur.samples.push(s);
  }
  if (cur) out.push(cur);
  return out;
}

/** % a una hora dada por interpolación lineal (las muestras de Desktop son cada ~15 min). */
function pctAt(samples: PctSample[], t: number): number | null {
  if (!samples.length || t < samples[0]!.t) return null;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (t <= b.t) return b.t === a.t ? b.pct : a.pct + ((b.pct - a.pct) * (t - a.t)) / (b.t - a.t);
  }
  return samples.at(-1)!.pct;
}

/**
 * CP-018.3 sobre datos reales: en cada ventana completa, a 1 h, 2 h y 3 h del inicio se proyecta el %
 * al final de la ventana con el ritmo del método y se compara con el % real al final.
 * Métodos: `recent:<min>` (ritmo de los últimos N min), `damp:<factor>:<min>` (D-5: ritmo de los
 * últimos N min × factor, el de R10) y `mean` (ritmo desde el inicio).
 * `windowFilter(i, n)` restringe las ventanas (p. ej. mitad de ajuste / mitad de validación).
 */
export function evaluateProjection(
  samples: PctSample[],
  opts: { windowMs?: number; checkpointsH?: number[]; method?: string; windowFilter?: (index: number, total: number) => boolean } = {},
): ProjectionEval {
  const windowMs = opts.windowMs ?? 5 * HOUR;
  const checkpoints = opts.checkpointsH ?? [1, 2, 3];
  const method = opts.method ?? 'recent:30';
  const cases: ProjectionCase[] = [];
  const all = splitWindows(samples, windowMs).filter((w) => w.complete && w.samples.length >= 4);
  const windows = opts.windowFilter ? all.filter((_, i) => opts.windowFilter!(i, all.length)) : all;
  const [kind, a1, a2] = method.split(':');
  const factor = kind === 'damp' ? Number(a1 ?? DEFAULT_RATE_DAMPING) : 1;
  const spanMin = kind === 'damp' ? Number(a2 ?? 60) : Number(a1 ?? 30);
  for (const w of windows) {
    const end = w.start + windowMs;
    const last = w.samples.at(-1)!;
    const actual = Math.min(100, last.t >= end ? (pctAt(w.samples, end) ?? last.pct) : last.pct);
    for (const h of checkpoints) {
      const t = w.start + h * HOUR;
      if (t > last.t) continue;
      const now = pctAt(w.samples, t);
      if (now === null) continue;
      let rateMs: number;
      if (method === 'mean') rateMs = now / (t - w.start);
      else {
        const span = spanMin * MIN;
        const before = pctAt(w.samples, Math.max(w.start, t - span)) ?? 0;
        rateMs = ((now - before) / Math.min(span, t - w.start)) * factor;
      }
      const projected = Math.min(100, now + Math.max(0, rateMs) * (end - t));
      cases.push({ windowStart: w.start, checkpointH: h, projectedPct: projected, actualPct: actual, error: Math.abs(projected - actual) / 100 });
    }
  }
  const errs = cases.map((c) => c.error).sort((a, b) => a - b);
  const q = (p: number) => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(p * errs.length))]! : 0);
  return {
    method,
    windows: windows.length,
    cases,
    meanError: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0,
    p90Error: q(0.9),
    maxError: errs.at(-1) ?? 0,
    within20: errs.length ? errs.filter((e) => e < 0.2).length / errs.length : 0,
  };
}
