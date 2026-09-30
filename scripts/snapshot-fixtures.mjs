#!/usr/bin/env node
// CP-003.1 / D-7: copia N transcripts reales recientes de Claude Code (con sus subagentes) a
// fixtures sanitizados. Por defecto es DRY-RUN: sólo imprime estadísticas; escribe únicamente con --write.
//
//   node scripts/snapshot-fixtures.mjs                 dry-run con 3 sesiones
//   node scripts/snapshot-fixtures.mjs --count 5       otra cantidad
//   node scripts/snapshot-fixtures.mjs --write         escribe packages/core/test/fixtures/claude-code/real-<n>.jsonl
//   --projects <dir>     otra carpeta de proyectos (default: $CONTEXTPILOT_CLAUDE_PROJECTS o ~/.claude/projects)
//   --out <dir>          otra carpeta destino
//   --max-lines N        líneas por archivo (default 600)      --max-bytes N  bytes por archivo (default 800 000)
//   --max-subagents N    subagentes por sesión (default 2)     --scan N       sesiones recientes a evaluar (default 40)
//   --identity a,b       términos de identidad extra que no pueden sobrevivir
//   --json               estadísticas en JSON
//
// Salida por sesión n: real-<n>.jsonl, real-<n>/subagents/agent-<k>.jsonl y real-<n>.expected.json
// (resumen de uso esperado del parser). Sale con código 1 si la verificación de fuga o de
// equivalencia de uso falla (y en ese caso NO escribe nada, aun con --write).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

export function parseArgs(argv) {
  const a = {
    count: 3,
    write: false,
    json: false,
    projects: undefined,
    out: join(ROOT, 'packages', 'core', 'test', 'fixtures', 'claude-code'),
    maxLines: 600,
    maxBytes: 800_000,
    maxSubagents: 2,
    scan: 40,
    identity: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`falta valor para ${x}`);
      return v;
    };
    if (x === '--write') a.write = true;
    else if (x === '--dry-run') a.write = false;
    else if (x === '--json') a.json = true;
    else if (x === '--count' || x === '-n') a.count = Number(next());
    else if (x === '--projects') a.projects = next();
    else if (x === '--out') a.out = next();
    else if (x === '--max-lines') a.maxLines = Number(next());
    else if (x === '--max-bytes') a.maxBytes = Number(next());
    else if (x === '--max-subagents') a.maxSubagents = Number(next());
    else if (x === '--scan') a.scan = Number(next());
    else if (x === '--identity') a.identity = next().split(',').filter(Boolean);
    else throw new Error(`opción desconocida: ${x}`);
  }
  return a;
}

/** Ejecuta el snapshot. `lib` = módulos snapshot.ts/transcripts.ts (inyectables para tests). */
export function run(args, lib) {
  const { snap, tr } = lib;
  const trunc = { maxLines: args.maxLines, maxBytes: args.maxBytes };
  const sets = tr.listTranscriptSets(args.projects ?? tr.claudeProjectsDir()).slice(0, args.scan);

  // 1) Candidatos: líneas acotadas del principal + subagentes que caen dentro de ese tramo.
  const candidates = sets.map((s) => {
    const mainLines = snap.boundedLines(readFileSync(s.main, 'utf8'), trunc);
    const end = snap.lastTimestamp(mainLines) || Infinity;
    const subs = [];
    for (const f of s.subagents) {
      if (subs.length >= args.maxSubagents) break;
      const lines = snap.boundedLines(readFileSync(f, 'utf8'), trunc);
      if (lines.length && snap.firstTimestamp(lines) <= end) subs.push({ file: f, lines });
    }
    const feats = snap.features([...mainLines, ...subs.flatMap((x) => x.lines)], subs.length);
    return { set: s, mainLines, subs, features: feats };
  });
  const picked = snap.pickSets(candidates.filter((c) => c.mainLines.length > 0), args.count);

  // 2) Sanitizar + verificar cada sesión.
  const results = [];
  picked.forEach((c, idx) => {
    const n = idx + 1;
    const files = [
      { name: `real-${n}.jsonl`, lines: c.mainLines, sidechain: false },
      ...c.subs.map((s, k) => ({ name: `real-${n}/subagents/agent-${k + 1}.jsonl`, lines: s.lines, sidechain: true })),
    ];
    const records = [];
    for (const f of files)
      for (const l of f.lines) {
        try {
          records.push(JSON.parse(l));
        } catch {
          /* línea no JSON */
        }
      }
    const identity = snap.identityTerms(records, args.identity);
    const ctx = { identity, stats: { keys: 0, tags: 0, values: 0 } };
    const out = files.map((f) => ({ ...f, sanitized: f.lines.map((l) => snap.sanitizeLine(l, ctx)) }));

    const leak = snap.leakCheck(
      out.flatMap((f) => f.lines),
      out.flatMap((f) => f.sanitized),
      identity,
    );
    const before = snap.usageOf(out.map((f) => ({ lines: f.lines, sidechain: f.sidechain })));
    const after = snap.usageOf(out.map((f) => ({ lines: f.sanitized, sidechain: f.sidechain })));
    const diff = snap.usageDiff(before, after);
    results.push({
      n,
      files: out.map((f) => ({ name: f.name, lines: f.lines.length, bytes: f.sanitized.reduce((b, l) => b + Buffer.byteLength(l) + 1, 0) })),
      features: c.features,
      usage: after,
      usageDiff: diff,
      harden: ctx.stats,
      identityTerms: identity.size,
      survivors: leak.survivors.length,
      // Muestra para revisión humana: palabras (sin dígitos; los ids/timestamps son metadatos conservados).
      survivorSample: leak.survivors.filter((t) => !/\d/.test(t)).slice(0, 80),
      identityHits: leak.identityHits,
      patternHits: leak.patternHits,
      ok: leak.ok && diff.length === 0,
      _out: out,
    });
  });

  const ok = results.length > 0 && results.every((r) => r.ok);
  const written = [];
  if (args.write && ok) {
    for (const r of results) {
      for (const f of r._out) {
        const p = join(args.out, f.name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.sanitized.join('\n') + '\n');
        written.push(p);
      }
      const exp = join(args.out, `real-${r.n}.expected.json`);
      writeFileSync(exp, JSON.stringify({ features: r.features, usage: r.usage }, null, 2) + '\n');
      written.push(exp);
    }
  }
  const report = {
    mode: args.write ? 'write' : 'dry-run',
    scanned: sets.length,
    picked: results.length,
    ok,
    written,
    sessions: results.map(({ _out, ...r }) => r),
  };
  return report;
}

export function print(r) {
  console.log(`snapshot-fixtures (${r.mode}): ${r.scanned} sesiones evaluadas, ${r.picked} elegidas → ${r.ok ? 'OK' : 'FALLA'}`);
  for (const s of r.sessions) {
    const f = s.features;
    console.log(
      `\nreal-${s.n}: ${s.files.map((x) => `${x.name} (${x.lines} líneas, ${(x.bytes / 1024).toFixed(0)} KB)`).join(', ')}`,
    );
    console.log(`  rasgos: subagentes=${f.subagents} ephemeral1h=${f.ephemeral1h} toolError=${f.toolError}`);
    console.log(
      `  uso: ${s.usage.events} llamadas (${s.usage.sidechainEvents} subagente), in=${s.usage.input} out=${s.usage.output} ` +
        `cacheRead=${s.usage.cacheRead} cacheWrite=${s.usage.cacheWrite} tools=${s.usage.toolCalls} (fallidas ${s.usage.failedToolCalls})`,
    );
    console.log(`  equivalencia de uso original↔sanitizado: ${s.usageDiff.length ? 'DIFIERE ' + s.usageDiff.join('; ') : 'idéntica'}`);
    console.log(`  capa 2: claves=${s.harden.keys} etiquetas=${s.harden.tags} valores=${s.harden.values}`);
    console.log(
      `  fuga: identidad=${s.identityHits.length ? s.identityHits.join(',') : 'ninguna'} (${s.identityTerms} términos) ` +
        `patrones=${s.patternHits.length ? s.patternHits.join(',') : 'ninguno'} tokens-sobrevivientes=${s.survivors} (estructura: claves/ids/tipos)`,
    );
  }
  if (r.mode === 'dry-run') console.log('\n(dry-run: no se escribió nada; usar --write)');
  else if (r.written.length) console.log(`\nEscritos:\n  ${r.written.join('\n  ')}`);
  else console.log('\nNo se escribió nada (verificación fallida).');
}

/** Punto de entrada CLI (también lo usa scripts/verify/snapshot-fixtures.mjs). */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const snap = await tsImport('./lib/snapshot.ts', import.meta.url);
  const tr = await tsImport('./lib/transcripts.ts', import.meta.url);
  const report = run(args, { snap, tr });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else print(report);
  process.exitCode = report.ok ? 0 : 1;
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
