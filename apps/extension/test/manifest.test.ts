// CP-037.1: manifest MV3 con permisos mínimos; dist/ con todos los archivos referenciados.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// build.mjs exporta el manifest y el validador (sin correr el build al importarlo)
const { manifest, validateDist } = (await import(pathToFileURL(join(root, 'build.mjs')).href)) as {
  manifest: Record<string, any>;
  validateDist: (dir?: string) => string[];
};

describe('manifest', () => {
  it('MV3 con permisos mínimos y hosts sólo de los 3 sitios + daemon', () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(['clipboardWrite', 'sidePanel', 'storage']);
    expect(manifest.host_permissions).toContain('http://127.0.0.1:47800/*');
    for (const h of manifest.host_permissions) expect(h).toMatch(/claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com|127\.0\.0\.1:47800/);
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.side_panel.default_path).toBe('sidepanel.html');
  });

  it('script MAIN en document_start sólo para sitios con captura de red; ISOLATED en los 3', () => {
    const main = manifest.content_scripts.find((c: any) => c.world === 'MAIN');
    expect(main).toMatchObject({ run_at: 'document_start', js: ['main-world.js'] });
    expect(main.matches.some((m: string) => m.includes('gemini'))).toBe(false);
    const iso = manifest.content_scripts.find((c: any) => !c.world);
    expect(iso.matches).toEqual(expect.arrayContaining(['https://claude.ai/*', 'https://chatgpt.com/*', 'https://gemini.google.com/*']));
  });
});

describe('dist/', () => {
  beforeAll(() => {
    if (!existsSync(join(root, 'dist', 'manifest.json'))) execFileSync(process.execPath, [join(root, 'build.mjs')], { cwd: root });
  }, 120_000);

  it('todos los archivos referenciados existen y el manifest valida', () => {
    expect(validateDist(join(root, 'dist'))).toEqual([]);
    const m = JSON.parse(readFileSync(join(root, 'dist', 'manifest.json'), 'utf8'));
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('los bundles no dependen de Node ni de módulos externos', () => {
    for (const f of readdirSync(join(root, 'dist')).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(join(root, 'dist', f), 'utf8');
      expect(src, f).not.toMatch(/\brequire\(|from ["']node:|^import /m);
    }
  });
});
