// Verifica RF-NOR-03 (±15 %): compara estimateTokens(texto de salida) con output_tokens reales
// en respuestas de Claude Code que sólo contienen texto (sin tool_use ni thinking).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { estimateTokens } from '../packages/core/src/index.ts';
const root = join(homedir(), '.claude', 'projects');
const files = readdirSync(root).flatMap((d) => { try { return readdirSync(join(root, d)).filter((x) => x.endsWith('.jsonl')).map((x) => join(root, d, x)); } catch { return []; } });
const byId = new Map<string, { text: string; out: number; bad: boolean }>();
for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) {
  let r: any; try { r = JSON.parse(line); } catch { continue; }
  if (r.type !== 'assistant' || !r.message?.id || !r.message.usage) continue;
  const e = byId.get(r.message.id) ?? { text: '', out: r.message.usage.output_tokens ?? 0, bad: false };
  for (const b of r.message.content ?? []) { if (b.type === 'text') e.text += b.text; else e.bad = true; }
  if (r.message.usage.output_tokens_details?.thinking_tokens) e.bad = true;
  e.out = Math.max(e.out, r.message.usage.output_tokens ?? 0);
  byId.set(r.message.id, e);
}
const samples = [...byId.values()].filter((e) => !e.bad && e.out >= 100 && e.text.length > 200);
let sumEst = 0, sumReal = 0; const errs: number[] = [];
for (const s of samples) { const est = estimateTokens(s.text, 'anthropic'); sumEst += est; sumReal += s.out; errs.push((est - s.out) / s.out); }
errs.sort((a, b) => a - b);
const q = (p: number) => (errs[Math.floor(p * (errs.length - 1))]! * 100).toFixed(1) + '%';
const within = errs.filter((e) => Math.abs(e) <= 0.15).length / errs.length;
console.log({ samples: samples.length, aggregateError: (((sumEst - sumReal) / sumReal) * 100).toFixed(1) + '%', p10: q(0.1), median: q(0.5), p90: q(0.9), within15pct: (within * 100).toFixed(0) + '%' });
