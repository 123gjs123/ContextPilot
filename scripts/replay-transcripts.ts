// Mide el ruido de las reglas sobre transcripts reales (DECISIONS «ruido de reglas»).
// Uso: npx tsx scripts/replay-transcripts.ts [opciones] [archivos...]
//   --top N         las N sesiones más grandes de ~/.claude/projects (default 5), con sus subagentes
//   --recent N      en lugar de las más grandes, las N más recientes
//   --rules R1,R2   sólo reportar esas reglas
//   --source S      claude-code (default) | codex | gemini-cli (para archivos explícitos)
//   --no-subagents  no incluir <sesión>/subagents/*.jsonl
//   --json          salida JSON (sin eventos, sólo métricas)
// Con archivos explícitos se reproducen todos juntos como un corpus.
import { basename } from 'node:path';
import { replay, type ReplayResult, type SourceParserKind } from './lib/replay.ts';
import { listTranscriptSets, type TranscriptSet } from './lib/transcripts.ts';

interface Args {
  top: number;
  recent?: number;
  rules?: string[];
  source: SourceParserKind;
  subagents: boolean;
  json: boolean;
  files: string[];
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { top: 5, source: 'claude-code', subagents: true, json: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`falta valor para ${x}`);
      return v;
    };
    if (x === '--top') a.top = Number(next());
    else if (x === '--recent') a.recent = Number(next());
    else if (x === '--rules') a.rules = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (x === '--source') a.source = next() as SourceParserKind;
    else if (x === '--no-subagents') a.subagents = false;
    else if (x === '--json') a.json = true;
    else if (x.startsWith('--')) throw new Error(`opción desconocida: ${x}`);
    else a.files.push(x);
  }
  return a;
}

function summary(r: ReplayResult) {
  const main = Object.values(r.sessions)[0];
  return {
    events: r.events.length,
    sessions: Object.keys(r.sessions).length,
    ctx: main?.contextSize,
    win: main?.contextWindow,
    cache: main?.cacheRatios.at(-1)?.toFixed(2),
    ttl: main?.cacheTtlMs,
    suggestionsByRule: r.suggestionsByRule,
    suppressedByRule: r.suppressedByRule,
    perActiveHour: r.perActiveHour,
    errors: r.errors.reduce((n, e) => n + e.count, 0),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows: { name: string; stats: ReturnType<typeof summary> }[] = [];
  let all: string[] = [];
  if (args.files.length) {
    const r = replay(args.files, { sourceParser: args.source, rules: args.rules });
    rows.push({ name: `${args.files.length} archivo(s)`, stats: summary(r) });
    all = args.files;
  } else {
    const sets = listTranscriptSets();
    const picked: TranscriptSet[] = args.recent ? sets.slice(0, args.recent) : [...sets].sort((a, b) => b.size - a.size).slice(0, args.top);
    for (const s of picked) {
      const files = [s.main, ...(args.subagents ? s.subagents : [])];
      all.push(...files);
      const r = replay(files, { sourceParser: 'claude-code', rules: args.rules });
      rows.push({ name: `${basename(s.main).slice(0, 8)}… (+${args.subagents ? s.subagents.length : 0} sub)`, stats: summary(r) });
    }
  }
  // Total del corpus (la métrica por hora activa se calcula sobre el conjunto).
  const total = all.length > 1 ? summary(replay(all, { sourceParser: args.source, rules: args.rules })) : undefined;
  if (args.json) {
    console.log(JSON.stringify({ sessions: rows, total }, null, 2));
    return;
  }
  for (const r of rows) console.log(r.name, r.stats);
  if (total) console.log('TOTAL', { events: total.events, suggestionsByRule: total.suggestionsByRule, perActiveHour: total.perActiveHour });
}

main();
