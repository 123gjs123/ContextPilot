// CP-030.4 / CP-030.6 — Criterio de fase 0 «tokens CLI = usage ±0 %» sobre TODOS los transcripts
// reales de ~/.claude/projects (sólo lectura). Para cada *.jsonl (incluidos <sesión>/subagents/*.jsonl)
// compara la suma input+output+cacheRead+cacheWrite de los TurnEvent del parser de core contra una
// suma independiente de `usage` deduplicada por message.id (sin el parser). Cuenta excepciones.
// Uso: npx tsx scripts/verify/real-transcripts-usage.ts [raíz]   → exit 0 si 0 excepciones y 0 diferencias.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ClaudeCodeParser, type TurnEvent } from '../../packages/core/src/index.ts';

const root = process.argv[2] ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (f.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function independentSum(text: string): { total: number; count: number } {
  const seen = new Set<string>();
  let total = 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.type !== 'assistant') continue;
    const m = r.message;
    if (!m?.id || !m.usage || m.model === '<synthetic>' || seen.has(m.id)) continue;
    seen.add(m.id);
    count++;
    const u = m.usage;
    total += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  return { total, count };
}

const files = walk(root);
let exceptions = 0;
let mismatches = 0;
let grandParser = 0;
let grandIndependent = 0;
let calls = 0;
let parseErrors = 0;
const versions = new Set<string>();
const bad: string[] = [];
const t0 = performance.now();
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const isSub = basename(dirname(f)) === 'subagents';
  const p = new ClaudeCodeParser(isSub ? { sidechain: true, parentSessionId: basename(dirname(dirname(f))), embedPrompts: false } : { embedPrompts: false });
  const events: TurnEvent[] = [];
  try {
    for (const line of text.split('\n')) events.push(...p.feed(line));
  } catch (e) {
    exceptions++;
    bad.push(`${f}: EXCEPCIÓN ${(e as Error).message}`);
    continue;
  }
  parseErrors += p.errors;
  for (const v of p.formatVersions) versions.add(v);
  const resp = events.filter((e) => (e.phase ?? 'response') === 'response');
  const sum = resp.reduce((s, e) => s + e.tokens.input + e.tokens.output + (e.tokens.cacheRead ?? 0) + (e.tokens.cacheWrite ?? 0), 0);
  const ind = independentSum(text);
  grandParser += sum;
  grandIndependent += ind.total;
  calls += resp.length;
  if (sum !== ind.total || resp.length !== ind.count) {
    mismatches++;
    if (bad.length < 20) bad.push(`${f}: parser ${sum} (${resp.length} llamadas) ≠ independiente ${ind.total} (${ind.count})`);
  }
}
console.log(
  JSON.stringify(
    {
      root,
      files: files.length,
      subagentFiles: files.filter((f) => basename(dirname(f)) === 'subagents').length,
      apiCalls: calls,
      exceptions,
      filesWithMismatch: mismatches,
      parserTokens: grandParser,
      independentTokens: grandIndependent,
      diff: grandParser - grandIndependent,
      nonJsonLines: parseErrors,
      formatVersions: [...versions].sort().slice(-5),
      ms: Math.round(performance.now() - t0),
    },
    null,
    2,
  ),
);
if (bad.length) console.log(bad.join('\n'));
process.exit(exceptions || mismatches ? 1 : 0);
