#!/usr/bin/env node
// RNF-07 / CP-028: consumo en reposo del daemon. Mide RSS (working set) y CPU del proceso durante
// N segundos. Por defecto arranca un daemon propio (CONTEXTPILOT_HOME temporal, puerto libre, tailers
// sobre los directorios reales en sólo lectura), espera el calentamiento y mide.
//   node scripts/verify/idle.mjs [--seconds 60] [--minutes N] [--warmup 10] [--pid <pid>] [--port 47890]
// Sale con 1 si RSS máx ≥ 100 MB o CPU promedio ≥ 1 % de un núcleo.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const seconds = args.includes('--minutes') ? opt('minutes', 1) * 60 : opt('seconds', 60);
const warmup = opt('warmup', 10);
const sampleEvery = Math.max(2, Math.min(10, Math.floor(seconds / 6)));

/** Working set (bytes) y CPU acumulada (s) del proceso, vía PowerShell (sin dependencias). */
function sample(pid) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64) $($p.TotalProcessorTime.TotalSeconds)"`],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`no se pudo leer el proceso ${pid}`);
  const [ws, cpu] = r.stdout.trim().split(/\s+/).map((x) => Number(x.replace(',', '.')));
  return { rss: ws, cpu, t: Date.now() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let pid = opt('pid', 0);
  let child = null;
  let home = null;
  if (!pid) {
    home = mkdtempSync(join(tmpdir(), 'cp-idle-'));
    const port = opt('port', 47890);
    // Un único proceso node con el loader de tsx (sin proceso intermedio).
    child = spawn(process.execPath, ['--import', 'tsx', join(root, 'apps', 'daemon', 'src', 'main.ts')], {
      cwd: root,
      env: { ...process.env, CONTEXTPILOT_HOME: home, CONTEXTPILOT_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.resume();
    child.stderr.resume();
    pid = child.pid;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (r.ok) break;
      } catch {
        await sleep(200);
      }
    }
    console.log(`daemon pid ${pid} en puerto ${port}; calentamiento ${warmup}s`);
    await sleep(warmup * 1000);
  }
  const samples = [sample(pid)];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await sleep(Math.min(sampleEvery * 1000, end - Date.now()));
    samples.push(sample(pid));
  }
  const first = samples[0];
  const last = samples.at(-1);
  const maxRss = Math.max(...samples.map((s) => s.rss));
  const cpuPct = ((last.cpu - first.cpu) / ((last.t - first.t) / 1000)) * 100;
  const result = {
    pid,
    seconds: Math.round((last.t - first.t) / 1000),
    samples: samples.length,
    maxRssMB: Math.round((maxRss / 1024 / 1024) * 10) / 10,
    avgCpuPct: Math.round(cpuPct * 100) / 100,
    ok: maxRss < 100 * 1024 * 1024 && cpuPct < 1,
  };
  console.log(JSON.stringify(result));
  if (child) child.kill();
  if (home) {
    await sleep(300);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Windows puede retener el archivo unos ms
    }
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`idle: ${e.message}`);
  process.exit(2);
});
