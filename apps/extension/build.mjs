// Build de la extensión MV3 con esbuild → apps/extension/dist (cargable "sin empaquetar").
// Uso: node build.mjs [--watch]. Al final valida el manifest y que existan todos los archivos
// referenciados (CP-037.1).
import { build, context } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

const DAEMON_ORIGIN = 'http://127.0.0.1:47800/*';
const NET_SITES = ['https://claude.ai/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*'];
const ALL_SITES = [...NET_SITES, 'https://gemini.google.com/*'];

export const manifest = {
  manifest_version: 3,
  name: 'ContextPilot',
  short_name: 'ContextPilot',
  version: pkg.version,
  description: 'Copiloto local de consumo: estima el contexto de tus chats y sugiere cuándo compactar o empezar de nuevo.',
  minimum_chrome_version: '116',
  permissions: ['storage', 'sidePanel', 'clipboardWrite'],
  host_permissions: [...ALL_SITES, DAEMON_ORIGIN],
  background: { service_worker: 'background.js' },
  action: { default_title: 'ContextPilot', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
  side_panel: { default_path: 'sidepanel.html' },
  options_ui: { page: 'options.html', open_in_tab: true },
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  content_scripts: [
    {
      // Mundo MAIN: envuelve fetch antes que los scripts de la página (sólo sitios con captura de red).
      matches: NET_SITES,
      js: ['main-world.js'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: false,
    },
    {
      matches: ALL_SITES,
      js: ['content.js'],
      run_at: 'document_start',
      all_frames: false,
    },
  ],
};

const entries = {
  background: 'src/entries/background.ts',
  content: 'src/entries/content.ts',
  'main-world': 'src/entries/main-world.ts',
  options: 'src/entries/options.ts',
  sidepanel: 'src/entries/sidepanel.ts',
};

const STATIC = ['options.html', 'sidepanel.html', 'ui.css'];

/** PNG sólido con un anillo (ícono simple, sin dependencias). */
function png(size) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r0 = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r0, y + 0.5 - r0) / r0;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const inCircle = d <= 1;
      const ring = d > 0.55 && d <= 0.8;
      const [r, g, b] = ring ? [255, 255, 255] : [37, 99, 235];
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = inCircle ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeStatic() {
  mkdirSync(join(dist, 'icons'), { recursive: true });
  for (const f of STATIC) copyFileSync(join(here, 'static', f), join(dist, f));
  for (const s of [16, 32, 48, 128]) writeFileSync(join(dist, 'icons', `${s}.png`), png(s));
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

/** Validación mínima del manifest MV3 y de los archivos referenciados. */
export function validateDist(dir = dist) {
  const errors = [];
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (m.manifest_version !== 3) errors.push('manifest_version debe ser 3');
  for (const k of ['name', 'version', 'background', 'permissions', 'host_permissions', 'content_scripts']) if (!(k in m)) errors.push(`falta ${k}`);
  if (!/^\d+(\.\d+){0,3}$/.test(m.version)) errors.push(`version inválida: ${m.version}`);
  const allowedPerms = new Set(['storage', 'sidePanel', 'clipboardWrite']);
  for (const p of m.permissions) if (!allowedPerms.has(p)) errors.push(`permiso no mínimo: ${p}`);
  for (const p of allowedPerms) if (!m.permissions.includes(p)) errors.push(`falta permiso ${p}`);
  const allowedHosts = /^(https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com)\/\*|http:\/\/127\.0\.0\.1:47800\/\*)$/;
  for (const h of m.host_permissions) if (!allowedHosts.test(h)) errors.push(`host no permitido: ${h}`);
  const files = new Set([m.background.service_worker, m.side_panel?.default_path, m.options_ui?.page]);
  for (const cs of m.content_scripts) {
    for (const f of cs.js ?? []) files.add(f);
    if (cs.world && !['MAIN', 'ISOLATED'].includes(cs.world)) errors.push(`world inválido: ${cs.world}`);
    if (!cs.matches?.length) errors.push('content_script sin matches');
  }
  for (const f of Object.values(m.icons ?? {})) files.add(f);
  for (const f of Object.values(m.action?.default_icon ?? {})) files.add(f);
  // Archivos referenciados desde los HTML (src/href relativos).
  for (const page of [m.side_panel?.default_path, m.options_ui?.page].filter(Boolean)) {
    const html = readFileSync(join(dir, page), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) files.add(ref);
  }
  for (const f of files) if (f && !existsSync(join(dir, f))) errors.push(`archivo referenciado inexistente: ${f}`);
  if (m.background.type === 'module') errors.push('el service worker se construye como IIFE: no declarar type module');
  return errors;
}

const options = {
  absWorkingDir: here,
  entryPoints: entries,
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: ['chrome116'],
  platform: 'browser',
  sourcemap: watch ? 'inline' : false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  if (watch) {
    writeStatic();
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
    writeStatic();
    const errors = validateDist();
    if (errors.length) {
      console.error('manifest/dist inválido:\n - ' + errors.join('\n - '));
      process.exit(1);
    }
    console.log(`dist/ listo (${Object.keys(entries).length} bundles, manifest MV3 validado)`);
  }
}
