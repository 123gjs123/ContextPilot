import type { PlanUsageView } from './types.js';

// Hallazgo del spike (docs/SPIKE-desktop.md): Claude Desktop guarda en
// %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\plan-usage-history.json
// muestras cada ~15 min de uso del plan: { version: 2, samples: [{ t, org, u: { fh, sd } }] }
// con fh = % de la ventana de 5 h y sd = % de la ventana de 7 días. Sólo lectura; no contiene contenido.

const STALE_MS = 45 * 60_000;

export function parsePlanUsage(raw: string, now = Date.now()): PlanUsageView | undefined {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const samples = (j as { samples?: unknown })?.samples;
  if (!Array.isArray(samples)) return undefined;
  let last: { t: number; fh: number; sd: number } | undefined;
  for (const s of samples) {
    const t = (s as { t?: unknown })?.t;
    const u = (s as { u?: { fh?: unknown; sd?: unknown } })?.u;
    if (typeof t !== 'number' || !u || typeof u.fh !== 'number' || typeof u.sd !== 'number') continue;
    if (!last || t > last.t) last = { t, fh: u.fh, sd: u.sd };
  }
  if (!last) return undefined;
  return {
    fiveHourPct: last.fh / 100,
    sevenDayPct: last.sd / 100,
    sampledAt: new Date(last.t).toISOString(),
    stale: now - last.t > STALE_MS,
  };
}
