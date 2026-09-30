#!/usr/bin/env node
// CP-001.3 — Verifica que las dependencias de producción de packages/* y apps/daemon no traen
// módulos nativos (*.node, binding.gyp). apps/desktop (Electron) y apps/extension quedan fuera.
// Uso: node scripts/verify/no-native.mjs   → exit 0 si no hay nativos; 1 si encuentra alguno.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKSPACES = [
  ...readdirSync(join(ROOT, 'packages')).map((d) => join(ROOT, 'packages', d)),
  join(ROOT, 'apps', 'daemon'),
];

/** Resuelve un paquete como lo haría Node: node_modules del que lo pide, luego hacia arriba. */
function resolvePkg(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const cand = join(dir, 'node_modules', name);
    if (existsSync(join(cand, 'package.json'))) return cand;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const seen = new Map(); // dir → name
const missing = [];
function visit(dir, name) {
  if (seen.has(dir)) return;
  seen.set(dir, name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const d = resolvePkg(dep, dir);
    if (d) visit(d, dep);
    else missing.push(`${name} → ${dep}`);
  }
  // optionalDependencies instaladas también cuentan (p. ej. bufferutil de ws)
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    const d = resolvePkg(dep, dir);
    if (d) visit(d, dep);
  }
}
for (const ws of WORKSPACES) visit(ws, JSON.parse(readFileSync(join(ws, 'package.json'), 'utf8')).name);

const hits = [];
function scan(dir, depth = 0) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // no bajar a node_modules anidados: esos paquetes se visitan por el grafo
      if (f === 'node_modules' || f === '.git') continue;
      if (depth < 12) scan(p, depth + 1);
    } else if (f.endsWith('.node') || f === 'binding.gyp') hits.push(p);
  }
}
for (const dir of seen.keys()) scan(dir);

const names = [...new Set(seen.values())].sort();
console.log(`paquetes de producción revisados (${names.length}): ${names.join(', ')}`);
if (missing.length) console.log(`dependencias no instaladas (ignoradas): ${missing.join('; ')}`);
if (hits.length) {
  console.log(`NATIVOS ENCONTRADOS (${hits.length}):\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log('OK: ningún *.node ni binding.gyp en dependencias de producción de packages/* y apps/daemon');
