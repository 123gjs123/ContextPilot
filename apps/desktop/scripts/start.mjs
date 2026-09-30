// Lanza Electron con el main ya compilado (apps/desktop/out/main.cjs).
// Uso: node apps/desktop/scripts/start.mjs [--smoke] [otros args para la app]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const main = join(appDir, 'out', 'main.cjs');
if (!existsSync(main)) {
  console.error('Falta out/main.cjs: corré `npm run build -w @contextpilot/desktop` primero.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const electron = require('electron'); // ruta al ejecutable

const env = { ...process.env };
// Electron rechaza --use-system-ca en NODE_OPTIONS (proxy corporativo): se quita sólo para Electron.
if (env.NODE_OPTIONS) {
  const cleaned = env.NODE_OPTIONS.split(/\s+/).filter((o) => o && o !== '--use-system-ca').join(' ');
  if (cleaned) env.NODE_OPTIONS = cleaned;
  else delete env.NODE_OPTIONS;
}
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [main, ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
