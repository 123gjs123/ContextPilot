#!/usr/bin/env node
// CP-057.1 / D-12: exportación semanal agregada y anónima del modo equipo (DECISIONS «modo equipo»).
//
//   node scripts/team-export.mjs --week                       semana ISO actual, desde el daemon → stdout
//   node scripts/team-export.mjs --week 2026-W40 --out team.json
//   node scripts/team-export.mjs --week 2026-W40 --offline    sin daemon: lee cp.db con sql.js + aggregateTeam
//   --db <ruta>   otra cp.db (default %LOCALAPPDATA%\ContextPilot\cp.db o $CONTEXTPILOT_HOME\cp.db)
//
// Online usa GET /team/export con el token de %LOCALAPPDATA%\ContextPilot\token. Antes de escribir,
// el resultado pasa por el test de fuga (sin hashes hex ≥ 16, ULID/UUID, rutas, campos identificadores,
// claves fuera del esquema ni buckets < 5 sesiones; offline además ningún string de las filas de origen).
// Si falla: no escribe nada y sale con código 1.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

export function parseArgs(argv) {
  const a = { week: undefined, out: undefined, offline: false, db: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--week') a.week = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : undefined;
    else if (x === '--out' || x === '-o') a.out = argv[++i];
    else if (x === '--offline') a.offline = true;
    else if (x === '--db') {
      a.db = argv[++i];
      a.offline = true;
    } else if (x === '--help' || x === '-h') a.help = true;
    else throw new Error(`opción desconocida: ${x}`);
    if ((x === '--out' || x === '-o' || x === '--db') && !argv[i]) throw new Error(`falta valor para ${x}`);
  }
  return a;
}

/** Ejecuta la exportación. `lib` = scripts/lib/team-export.ts. Devuelve { code, exp?, problems? }. */
export async function run(argv, lib, { env = process.env, log = console.log, err = console.error, now = Date.now() } = {}) {
  const a = parseArgs(argv);
  if (a.help) {
    log('Uso: node scripts/team-export.mjs --week [YYYY-Www] [--out archivo.json] [--offline] [--db cp.db]');
    return { code: 0 };
  }
  const range = lib.weekRange(a.week, now);
  let exp;
  let forbidden = [];
  if (a.offline) {
    const r = await lib.exportOffline(a.db ?? lib.defaultDbPath(env), range.from, range.to, now);
    exp = r.exp;
    forbidden = r.forbidden;
  } else {
    exp = await lib.fetchOnline(range.from, range.to, env);
  }
  const leak = lib.teamLeakCheck(exp, forbidden);
  if (!leak.ok) {
    err(`Test de fuga FALLIDO (${range.week}); no se escribe nada:\n  - ${leak.problems.join('\n  - ')}`);
    return { code: 1, problems: leak.problems };
  }
  const text = JSON.stringify(exp, null, 2) + '\n';
  if (a.out) {
    const p = resolve(a.out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    err(
      `Exportado ${range.week} (${a.offline ? 'offline, cp.db' : 'daemon'}) → ${p}: ` +
        `${exp.byProvider.length} bucket(s) proveedor, ${exp.byRule.length} regla(s), ${exp.suppressedBuckets} suprimido(s) (< ${exp.minBucketSessions} sesiones). Test de fuga OK.`,
    );
  } else log(text.trimEnd());
  return { code: 0, exp, week: range.week };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const lib = await tsImport('./lib/team-export.ts', import.meta.url);
    process.exitCode = (await run(process.argv.slice(2), lib)).code;
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exitCode = 2;
  }
}
