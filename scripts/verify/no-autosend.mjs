#!/usr/bin/env node
// CP-058.2 — Verifica estáticamente que apps/extension/src no automatiza envíos: sin `.click()`,
// `requestSubmit`, `.submit()`, ni `dispatchEvent` de teclado (KeyboardEvent / keydown / keypress
// / Enter sintético). Escuchar `keydown` del usuario (addEventListener / listen) está permitido.
// `dispatchEvent` sólo se permite con Event('input'|'change') o InputEvent (pegado del traspaso).
// Uso: node scripts/verify/no-autosend.mjs [dir]  → exit 0 si limpio; 1 con la lista de hallazgos.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = process.argv[2] ?? join(ROOT, 'apps', 'extension', 'src');

const FORBIDDEN = [
  [/\.click\s*\(/, 'llamada a .click()'],
  [/\brequestSubmit\b/, 'requestSubmit'],
  [/\.submit\s*\(/, 'llamada a .submit()'],
  [/new\s+(?:\w+\.)?KeyboardEvent\s*\(/, 'construcción de KeyboardEvent (tecla sintética)'],
  [/new\s+(?:\w+\.)?Event\s*\(\s*['"](?:keydown|keypress|keyup|submit)['"]/, 'Event de teclado/submit sintético'],
];
const DISPATCH_OK = /['"](?:input|change)['"]/;
const DISPATCH_BAD = /KeyboardEvent|MouseEvent|PointerEvent|SubmitEvent|['"](?:keydown|keypress|keyup|submit|click|mousedown|mouseup|pointerdown|pointerup)['"]/;

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|js|mjs)$/.test(f) ? [p] : [];
  });
}

const findings = [];
let dispatchCount = 0;
for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    for (const [re, why] of FORBIDDEN) if (re.test(code)) findings.push(`${relative(ROOT, file)}:${i + 1}: ${why}: ${line.trim()}`);
    if (/dispatchEvent\s*\(/.test(code)) {
      dispatchCount++;
      // El evento puede estar en las 2 líneas siguientes: se revisa esa ventana.
      const win = [code, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ').replace(/\s+/g, ' ');
      const call = win.slice(win.indexOf('dispatchEvent')).slice(0, 220);
      if (DISPATCH_BAD.test(call) || !DISPATCH_OK.test(call))
        findings.push(`${relative(ROOT, file)}:${i + 1}: dispatchEvent fuera de la lista blanca (sólo input/change): ${call}`);
    }
  });
}

console.log(`archivos revisados en ${relative(ROOT, SRC) || SRC}; dispatchEvent encontrados: ${dispatchCount}`);
if (findings.length) {
  console.log(`HALLAZGOS (${findings.length}):\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log('OK: sin .click(), requestSubmit, .submit() ni eventos de teclado/submit sintéticos');
