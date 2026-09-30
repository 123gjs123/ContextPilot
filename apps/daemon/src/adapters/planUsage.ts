import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanProfile, UsageWindow } from '@contextpilot/core';
import type { HealthRegistry } from '../health.js';
import type { Logger } from '../log.js';

// Uso del plan informado por Claude Desktop (docs/SPIKE-desktop.md): plan-usage-history.json con
// muestras cada ~15 min { version: 2, samples: [{ t, org, u: { fh, sd } }] } — fh = % de la ventana
// de 5 h, sd = % de la ventana de 7 días. Sólo lectura; no contiene contenido. El id de organización
// nunca sale de este módulo.
// Para R10 se convierte en una serie de incrementos de % (budget = 100) sobre la ventana de 5 h: el
// dato es del proveedor (exacto), no una estimación por tokens.

const NAME = 'claude-plan-usage';
export const PLAN_USAGE_STALE_MS = 45 * 60_000;
export const FIVE_HOURS_MS = 5 * 3_600_000;
export const SEVEN_DAYS_MS = 7 * 86_400_000;

export interface PlanSample {
  t: number;
  fh: number;
  sd: number;
}

export interface PlanUsageSnapshot {
  /** Fracciones 0..1 (misma convención que contextPct). */
  fiveHourPct: number;
  sevenDayPct: number;
  ts: string;
  stale: boolean;
}

export function planUsagePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.CONTEXTPILOT_PLAN_USAGE_FILE) return [env.CONTEXTPILOT_PLAN_USAGE_FILE];
  const out: string[] = [];
  const pk = join(env.LOCALAPPDATA ?? '', 'Packages');
  try {
    for (const d of readdirSync(pk)) {
      if (/^Claude_/.test(d)) out.push(join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'plan-usage-history.json'));
    }
  } catch {
    // sin carpeta Packages
  }
  if (env.APPDATA) out.push(join(env.APPDATA, 'Claude', 'plan-usage-history.json'));
  return out;
}

/** Muestras válidas de la organización de la muestra más reciente, ordenadas por tiempo. */
export function parsePlanSamples(raw: string): PlanSample[] | null {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(j?.samples)) return null;
  const valid = (j.samples as any[]).filter(
    (s) => typeof s?.t === 'number' && typeof s?.u?.fh === 'number' && typeof s?.u?.sd === 'number',
  );
  if (!valid.length) return [];
  const latest = valid.reduce((a, b) => (b.t > a.t ? b : a));
  return valid
    .filter((s) => s.org === latest.org)
    .map((s) => ({ t: s.t, fh: s.u.fh, sd: s.u.sd }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Serie para R10 en unidades de % de la ventana de 5 h: el primer punto lleva el % acumulado y los
 * siguientes, los incrementos. Si el % cae (la ventana se renovó), la serie arranca en esa muestra.
 * Así, la suma de la serie = % usado en la ventana actual y su primer ts ≈ inicio de la ventana.
 */
export function planUsagePoints(
  samples: PlanSample[],
  now = Date.now(),
  field: 'fh' | 'sd' = 'fh',
  windowMs = field === 'fh' ? FIVE_HOURS_MS : SEVEN_DAYS_MS,
): { ts: number; tokens: number }[] {
  const inWin = samples.filter((s) => s.t >= now - windowMs && s.t <= now);
  let start = 0;
  for (let i = 1; i < inWin.length; i++) if (inWin[i]![field] < inWin[i - 1]![field]) start = i;
  const seg = inWin.slice(start);
  return seg.map((s, i) => ({ ts: s.t, tokens: i === 0 ? s[field] : Math.max(0, s[field] - seg[i - 1]![field]) }));
}

/**
 * Plan sintético en unidades de % (límite = 100) para que R10 proyecte con la serie de Desktop.
 * D-15: dos ventanas (5 h y 7 días), cada una con su propia serie (`byWindow`).
 */
export const PERCENT_PLAN: PlanProfile = {
  provider: 'anthropic',
  kind: 'subscription',
  windowMs: FIVE_HOURS_MS,
  windowBudgetTokens: 100,
  windows: [
    { hours: 5, limit: 100 },
    { days: 7, limit: 100 },
  ],
};

export class PlanUsageAdapter {
  private samples: PlanSample[] = [];
  private file: string | null = null;
  private mtime = 0;
  private timer: NodeJS.Timeout | null = null;
  private wasFresh = false;

  constructor(
    private o: {
      health: HealthRegistry;
      log: Logger;
      env?: NodeJS.ProcessEnv;
      pollMs?: number;
      /** Cambió la frescura (el plan sintético entra o sale de la config del motor). */
      onChange?: () => void;
      /** D-22: llegaron muestras nuevas (el archivo cambió): reevaluar las reglas de cuenta. */
      onSamples?: () => void;
    },
  ) {}

  start(): void {
    this.o.health.set(NAME, { status: 'no-data', detail: 'buscando plan-usage-history.json' });
    this.poll();
    // CP-028: el archivo cambia cada ~15 min; un stat por minuto es despreciable.
    this.timer = setInterval(() => this.poll(), this.o.pollMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  poll(): void {
    const file = planUsagePaths(this.o.env).find((p) => existsSync(p)) ?? null;
    if (!file) {
      if (this.samples.length) {
        this.samples = [];
        this.o.onChange?.();
      }
      this.o.health.set(NAME, { status: 'no-data', detail: 'Claude Desktop no dejó plan-usage-history.json' });
      return;
    }
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      return;
    }
    if (file === this.file && mtime === this.mtime) {
      this.refreshHealth();
      return;
    }
    this.file = file;
    this.mtime = mtime;
    let samples: PlanSample[] | null = null;
    try {
      samples = parsePlanSamples(readFileSync(file, 'utf8'));
    } catch {
      samples = null;
    }
    if (samples === null) {
      this.o.health.set(NAME, { status: 'error', detail: 'formato de plan-usage-history.json desconocido' });
      return;
    }
    this.samples = samples;
    this.refreshHealth();
    this.o.onSamples?.();
  }

  private refreshHealth(): void {
    const fresh = this.fresh();
    if (fresh !== this.wasFresh) {
      this.wasFresh = fresh;
      this.o.onChange?.();
    }
    const last = this.samples.at(-1);
    if (!last) {
      this.o.health.set(NAME, { status: 'no-data', detail: 'sin muestras' });
      return;
    }
    const stale = Date.now() - last.t > PLAN_USAGE_STALE_MS;
    this.o.health.set(NAME, {
      status: 'ok',
      lastEventAt: new Date(last.t).toISOString(),
      formatVersion: '2',
      detail: stale ? 'muestra vieja (Claude Desktop cerrado?)' : undefined,
    });
  }

  latest(now = Date.now()): PlanUsageSnapshot | undefined {
    const last = this.samples.at(-1);
    if (!last) return undefined;
    return { fiveHourPct: last.fh / 100, sevenDayPct: last.sd / 100, ts: new Date(last.t).toISOString(), stale: now - last.t > PLAN_USAGE_STALE_MS };
  }

  /** Serie de R10 si hay una muestra fresca; undefined si no aplica. */
  usageWindow(now = Date.now()): UsageWindow | undefined {
    const last = this.samples.at(-1);
    if (!last || now - last.t > PLAN_USAGE_STALE_MS) return undefined;
    const five = planUsagePoints(this.samples, now, 'fh');
    return { provider: 'anthropic', points: five, byWindow: { '5h': five, '168h': planUsagePoints(this.samples, now, 'sd') } };
  }

  /** Muestras crudas (para la evaluación de la proyección, D-5). */
  allSamples(): PlanSample[] {
    return this.samples.slice();
  }

  fresh(now = Date.now()): boolean {
    const last = this.samples.at(-1);
    return !!last && now - last.t <= PLAN_USAGE_STALE_MS;
  }
}
