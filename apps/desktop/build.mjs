// Build de la app desktop con esbuild: main (node/electron, CJS), preload (CJS, sandbox) y
// renderer (browser, IIFE) → apps/desktop/out/. Uso: node build.mjs [--watch]
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
const watch = process.argv.includes('--watch');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'renderer'), { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2023', charset: 'utf8' };

const configs = [
  {
    ...common,
    entryPoints: [join(here, 'src/main/main.ts')],
    outfile: join(out, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    // Se resuelven en runtime desde node_modules de la raíz.
    external: ['electron', 'chrome-remote-interface', 'ws', 'bufferutil', 'utf-8-validate'],
  },
  {
    ...common,
    entryPoints: [join(here, 'src/preload/preload.ts')],
    outfile: join(out, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: {
      overlay: join(here, 'src/renderer/overlay.ts'),
      dashboard: join(here, 'src/renderer/dashboard.ts'),
    },
    outdir: join(out, 'renderer'),
    platform: 'browser',
    format: 'iife',
  },
];

for (const f of ['overlay.html', 'dashboard.html', 'styles.css']) {
  copyFileSync(join(here, 'src/renderer', f), join(out, 'renderer', f));
}

if (watch) {
  for (const c of configs) await (await context(c)).watch();
  console.log('[desktop] watching…');
} else {
  await Promise.all(configs.map((c) => build(c)));
  console.log('[desktop] build ok →', out);
}
