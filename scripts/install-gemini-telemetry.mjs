#!/usr/bin/env node
// CP-034.3 / D-12: activa (o quita) la telemetría local de Gemini CLI en ~/.gemini/settings.json para
// que el daemon lea `telemetry.outfile` (DECISIONS: fuente primaria = archivo; OTLP/HTTP JSON secundaria).
//
//   node scripts/install-gemini-telemetry.mjs                 escribe el bloque telemetry (outfile)
//   node scripts/install-gemini-telemetry.mjs --dry-run       sólo muestra el diff, no escribe
//   node scripts/install-gemini-telemetry.mjs --uninstall     restaura el bloque telemetry previo (o lo quita)
//   --outfile <ruta>   archivo de telemetría (default ~/.gemini/telemetry.log = default del daemon)
//   --otlp [url]       en lugar de archivo, exportar OTLP/HTTP JSON al daemon (default http://127.0.0.1:47800/otlp)
//   --settings <ruta>  otro settings.json          --home <dir>  otra carpeta home (tests)
//
// Bloque escrito (esquema `telemetry` de Gemini CLI: enabled, target, otlpEndpoint, otlpProtocol,
// outfile, logPrompts, useCollector):
//   { "enabled": true, "target": "local", "otlpEndpoint": "", "outfile": "<ruta>", "logPrompts": false }
// logPrompts=false: el texto de los prompts NO se escribe en la telemetría (RNF-01); el daemon sólo
// necesita contadores de tokens. Otras claves de `telemetry` y del resto de settings se conservan.
// Backup `settings.json.cp-bak` una vez, antes del primer cambio. Idempotente.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_OTLP = 'http://127.0.0.1:47800/otlp';

export function parseArgs(argv) {
  const a = { dryRun: false, uninstall: false, outfile: undefined, otlp: undefined, settings: undefined, home: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`falta valor para ${x}`);
      return v;
    };
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--uninstall') a.uninstall = true;
    else if (x === '--outfile') a.outfile = next();
    else if (x === '--settings') a.settings = next();
    else if (x === '--home') a.home = next();
    else if (x === '--otlp') a.otlp = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : DEFAULT_OTLP;
    else if (x === '--help' || x === '-h') a.help = true;
    else throw new Error(`opción desconocida: ${x}`);
  }
  return a;
}

export function paths(a) {
  const home = a.home ?? homedir();
  const settings = resolve(a.settings ?? join(home, '.gemini', 'settings.json'));
  const outfile = resolve(a.outfile ?? join(home, '.gemini', 'telemetry.log')).replace(/\\/g, '/');
  return { home, settings, backup: settings + '.cp-bak', outfile };
}

/** Quita comentarios // y /* *\/ fuera de strings (Gemini CLI acepta JSON con comentarios). */
export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out;
}

export function parseSettings(text) {
  if (text === undefined || !text.trim()) return { obj: {}, hadComments: false };
  const stripped = stripJsonComments(text);
  const obj = JSON.parse(stripped);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('settings.json no es un objeto JSON');
  return { obj, hadComments: stripped.replace(/\s/g, '') !== text.replace(/\s/g, '') };
}

/** Bloque telemetry deseado. */
export function desiredTelemetry(opts) {
  if (opts.otlp) return { enabled: true, target: 'local', otlpEndpoint: opts.otlp, otlpProtocol: 'http', logPrompts: false };
  return { enabled: true, target: 'local', otlpEndpoint: '', outfile: opts.outfile, logPrompts: false };
}

/** ¿El bloque telemetry parece escrito por este script? */
export function isOwnTelemetry(t, opts) {
  if (!t || typeof t !== 'object') return false;
  if (t.target !== 'local' || t.logPrompts !== false) return false;
  const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/').toLowerCase() : '');
  if (t.outfile && opts.outfile && norm(t.outfile) === norm(opts.outfile)) return true;
  return typeof t.otlpEndpoint === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/otlp\/?$/.test(t.otlpEndpoint);
}

/** Devuelve el objeto settings resultante de instalar (no muta la entrada). */
export function planInstall(obj, opts) {
  const next = structuredClone(obj);
  const cur = next.telemetry && typeof next.telemetry === 'object' ? next.telemetry : {};
  const want = desiredTelemetry(opts);
  const merged = { ...cur, ...want };
  // En modo OTLP se quita outfile (si no, Gemini CLI prioriza el archivo); en modo archivo, otlpProtocol sobra.
  if (opts.otlp) delete merged.outfile;
  else if (!cur.otlpProtocol) delete merged.otlpProtocol;
  next.telemetry = merged;
  return next;
}

/** Devuelve el objeto settings resultante de desinstalar. `backupObj` = settings previos (si hay backup). */
export function planUninstall(obj, opts, backupObj) {
  const next = structuredClone(obj);
  // Un bloque que no escribió este script (otra ruta, target gcp, logPrompts true...) no se toca.
  if (!isOwnTelemetry(next.telemetry, opts)) return next;
  if (backupObj && Object.prototype.hasOwnProperty.call(backupObj, 'telemetry')) next.telemetry = structuredClone(backupObj.telemetry);
  else delete next.telemetry;
  return next;
}

const stringify = (o) => JSON.stringify(o, null, 2) + '\n';

/** Diff de líneas (LCS) estilo unificado sin contexto de hunks: suficiente para archivos chicos. */
export function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const m = x.length;
  const n = y.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) {
      out.push('  ' + x[i]);
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) out.push('+ ' + y[j++]);
    else out.push('- ' + x[i++]);
  }
  return out.filter((l, k, arr) => l.trim() !== '' || k < arr.length - 1).join('\n');
}

function writeAtomic(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.cp-tmp-${process.pid}`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, p);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nada */
    }
    throw e;
  }
}

/**
 * Ejecuta el instalador. Devuelve { code, changed, diff, settingsPath, backupPath, messages }.
 * `log` recibe las líneas a imprimir (default console.log).
 */
export function run(argv, log = console.log) {
  const a = parseArgs(argv);
  if (a.help) {
    log('Uso: node scripts/install-gemini-telemetry.mjs [--dry-run] [--uninstall] [--outfile <ruta>] [--otlp [url]] [--settings <ruta>]');
    return { code: 0, changed: false };
  }
  const p = paths(a);
  const opts = { outfile: p.outfile, otlp: a.otlp };
  const before = existsSync(p.settings) ? readFileSync(p.settings, 'utf8') : undefined;
  let parsed;
  try {
    parsed = parseSettings(before);
  } catch (e) {
    log(`ERROR: ${p.settings} no es JSON válido (${e.message}); no se modifica.`);
    return { code: 2, changed: false, settingsPath: p.settings };
  }
  let backupObj;
  if (a.uninstall && existsSync(p.backup)) {
    try {
      backupObj = parseSettings(readFileSync(p.backup, 'utf8')).obj;
    } catch {
      backupObj = undefined;
    }
  }
  const nextObj = a.uninstall ? planUninstall(parsed.obj, opts, backupObj) : planInstall(parsed.obj, opts);
  const beforeCanon = before === undefined ? '' : stringify(parsed.obj);
  const after = stringify(nextObj);
  const changed = beforeCanon !== after;
  const diff = lineDiff(beforeCanon, after);

  log(`${a.uninstall ? 'Desinstalar' : 'Instalar'} telemetría de Gemini CLI en ${p.settings}${a.dryRun ? ' (dry-run)' : ''}`);
  if (!changed) {
    log('Sin cambios (ya estaba así).');
    return { code: 0, changed: false, diff: '', settingsPath: p.settings, backupPath: p.backup };
  }
  log(diff);
  if (parsed.hadComments) log('Aviso: settings.json tiene comentarios; al escribir se pierden (quedan en el backup).');
  if (a.dryRun) return { code: 0, changed: true, diff, settingsPath: p.settings, backupPath: p.backup, written: false };

  if (before !== undefined && !existsSync(p.backup)) copyFileSync(p.settings, p.backup);
  writeAtomic(p.settings, after);
  log(`Escrito. Backup: ${existsSync(p.backup) ? p.backup : '(no había settings previo)'}`);
  if (!a.uninstall && !a.otlp) log(`El daemon lee ${p.outfile} (PUT /config daemon.geminiOutfile si usás otra ruta).`);
  return { code: 0, changed: true, diff, settingsPath: p.settings, backupPath: p.backup, written: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = run(process.argv.slice(2)).code;
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exitCode = 2;
  }
}
