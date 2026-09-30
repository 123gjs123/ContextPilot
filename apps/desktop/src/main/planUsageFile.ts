import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlanUsage } from '../shared/planUsage.js';
import type { PlanUsageView } from '../shared/types.js';

// Lectura (sólo lectura) del historial de uso del plan que guarda Claude Desktop (ver spike).

export function planUsagePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA ?? '';
  const out: string[] = [];
  const pk = join(local, 'Packages');
  if (existsSync(pk)) {
    for (const d of readdirSync(pk)) {
      if (/^Claude_/.test(d)) out.push(join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'plan-usage-history.json'));
    }
  }
  if (env.APPDATA) out.push(join(env.APPDATA, 'Claude', 'plan-usage-history.json'));
  return out.filter((p) => existsSync(p));
}

export function readPlanUsage(env: NodeJS.ProcessEnv = process.env): PlanUsageView | undefined {
  for (const p of planUsagePaths(env)) {
    try {
      const v = parsePlanUsage(readFileSync(p, 'utf8'));
      if (v) return v;
    } catch {
      /* siguiente */
    }
  }
  return undefined;
}
