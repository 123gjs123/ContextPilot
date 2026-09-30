// CP-005.3 — Error ABSOLUTO relativo del estimador local contra output_tokens reales de Claude Code
// (sólo lectura de ~/.claude/projects). Muestras: respuestas de sólo texto, sin thinking, con
// output_tokens ≥ 200 (umbral del criterio). Criterio: mediana |err| ≤ 15 % y p90 |err| ≤ 25 %.
// Complementa scripts/verify-estimator.ts (que reporta error con signo y umbral ≥ 100).
// Uso: npx tsx scripts/verify/estimator-abs.ts   → exit 0 si cumple.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { estimateTokens } from '../../packages/core/src/index.ts';

const root = join(homedir(), '.claude', 'projects');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    try {
      return statSync(p).isDirectory() ? walk(p) : f.endsWith('.jsonl') ? [p] : [];
    } catch {
      return [];
    }
  });

const byId = new Map<string, { text: string; out: number; bad: boolean }>();
for (const f of walk(root))
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.type !== 'assistant' || !r.message?.id || !r.message.usage) continue;
    const e = byId.get(r.message.id) ?? { text: '', out: 0, bad: false };
    for (const b of r.message.content ?? []) {
      if (b.type === 'text') e.text += b.text;
      else e.bad = true;
    }
    if (r.message.usage.output_tokens_details?.thinking_tokens) e.bad = true;
    e.out = Math.max(e.out, r.message.usage.output_tokens ?? 0);
    byId.set(r.message.id, e);
  }

const samples = [...byId.values()].filter((e) => !e.bad && e.out >= 200 && e.text.length > 0);
const abs = samples.map((s) => Math.abs(estimateTokens(s.text, 'anthropic') - s.out) / s.out).sort((a, b) => a - b);
const q = (p: number) => abs[Math.floor(p * (abs.length - 1))]!;
const res = { samples: abs.length, medianAbs: +(q(0.5) * 100).toFixed(1), p90Abs: +(q(0.9) * 100).toFixed(1), within15: +((abs.filter((x) => x <= 0.15).length / abs.length) * 100).toFixed(0) };
console.log(JSON.stringify(res));
process.exit(res.medianAbs <= 15 && res.p90Abs <= 25 ? 0 : 1);
