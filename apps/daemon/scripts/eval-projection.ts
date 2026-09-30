// D-5 / CP-018.3: error de la proyección de R10 a 1 h, 2 h y 3 h del inicio de cada ventana de 5 h,
// medido sobre plan-usage-history.json de Claude Desktop (sólo lectura) o el archivo indicado.
// Ronda 2: además del error, cuántas ventanas que se agotaron de verdad se detectan (proyección ≥ 100 %)
// y cuántas falsas alarmas; y la partición cronológica ajuste (1ª mitad) / validación (2ª mitad) con la
// que se eligió la amortiguación de R10 (`damp:0.6:60`).
// Uso: npx tsx apps/daemon/scripts/eval-projection.ts [ruta.json]
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_RATE_DAMPING, evaluateProjection, type ProjectionEval } from '@contextpilot/core';
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
const METHODS = ['recent:15', 'recent:30', 'recent:60', 'recent:120', 'mean', 'damp:0.4:60', 'damp:0.5:60', `damp:${DEFAULT_RATE_DAMPING}:60`, 'damp:0.7:60', 'damp:0.8:60'];
const pctOf = (x: number) => `${(x * 100).toFixed(1)}%`;
function line(label: string, r: ProjectionEval): string {
  const byH = [1, 2, 3].map((h) => {
    const e = r.cases.filter((c) => c.checkpointH === h).map((c) => c.error);
    return `${h}h n=${e.length} media=${e.length ? pctOf(e.reduce((a, b) => a + b, 0) / e.length) : '—'}`;
  });
  // Agotamiento: casos cuya ventana terminó ≥ 99 % y cuántos proyectaron ≥ 100 %; falsas alarmas = proyectó ≥ 100 % sin agotarse.
  const pos = r.cases.filter((c) => c.actualPct >= 99);
  const hit = pos.filter((c) => c.projectedPct >= 100).length;
  const fa = r.cases.filter((c) => c.actualPct < 99 && c.projectedPct >= 100).length;
  return `${label.padEnd(12)} ventanas=${r.windows} casos=${r.cases.length} media=${pctOf(r.meanError)} p90=${pctOf(r.p90Error)} <20%=${(r.within20 * 100).toFixed(0)}% | ${byH.join(' · ')} | agotamiento ${hit}/${pos.length} falsas=${fa}`;
}
console.log('— todas las ventanas');
for (const method of METHODS) console.log(line(method, evaluateProjection(pct, { method })));
const first = (i: number, n: number) => i < Math.floor(n / 2);
const second = (i: number, n: number) => i >= Math.floor(n / 2);
console.log('— ajuste (1ª mitad cronológica de las ventanas)');
for (const method of METHODS) console.log(line(method, evaluateProjection(pct, { method, windowFilter: first })));
console.log('— validación (2ª mitad; no se usó para elegir)');
for (const method of METHODS) console.log(line(method, evaluateProjection(pct, { method, windowFilter: second })));
