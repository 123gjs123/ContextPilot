// D-5 / CP-018.3: error de la proyección de R10 a 1 h, 2 h y 3 h del inicio de cada ventana de 5 h,
// medido sobre plan-usage-history.json de Claude Desktop (sólo lectura) o el archivo indicado.
// Uso: npx tsx apps/daemon/scripts/eval-projection.ts [ruta.json]
import { existsSync, readFileSync } from 'node:fs';
import { evaluateProjection } from '@contextpilot/core';
import { parsePlanSamples, planUsagePaths } from '../src/adapters/planUsage.js';

const file = process.argv[2] ?? planUsagePaths().find((p) => existsSync(p));
if (!file || !existsSync(file)) {
  console.log('sin plan-usage-history.json: nada que evaluar');
  process.exit(0);
}
const samples = parsePlanSamples(readFileSync(file, 'utf8')) ?? [];
const pct = samples.map((s) => ({ t: s.t, pct: s.fh }));
const span = samples.length ? `${new Date(samples[0]!.t).toISOString()} → ${new Date(samples.at(-1)!.t).toISOString()}` : '—';
console.log(`muestras: ${samples.length} (${span})`);
for (const method of ['recent:15', 'recent:30', 'recent:60', 'recent:120', 'mean']) {
  const r = evaluateProjection(pct, { method });
  const byH = [1, 2, 3].map((h) => {
    const e = r.cases.filter((c) => c.checkpointH === h).map((c) => c.error);
    return `${h}h n=${e.length} media=${e.length ? ((e.reduce((a, b) => a + b, 0) / e.length) * 100).toFixed(1) : '—'}%`;
  });
  console.log(
    `${method.padEnd(10)} ventanas=${r.windows} casos=${r.cases.length} media=${(r.meanError * 100).toFixed(1)}% p90=${(r.p90Error * 100).toFixed(1)}% máx=${(r.maxError * 100).toFixed(1)}% <20%=${(r.within20 * 100).toFixed(0)}% | ${byH.join(' · ')}`,
  );
}
