#!/usr/bin/env node
// CP-002 / RNF-11: exporta las CAs raíz e intermedias del almacén de Windows a
// %LOCALAPPDATA%\ContextPilot\ca.pem y ejecuta el comando dado con NODE_EXTRA_CA_CERTS
// (sólo para el proceso hijo; no instala nada en el sistema).
//   node scripts/with-ca.mjs [--refresh] -- <comando> [args...]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cpHome } from './lib/cp.mjs';

const MAX_AGE_MS = 24 * 3_600_000;

export function exportCa(file, refresh = false) {
  if (!refresh && existsSync(file) && Date.now() - statSync(file).mtimeMs < MAX_AGE_MS && statSync(file).size > 0) return file;
  mkdirSync(join(file, '..'), { recursive: true });
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$stores = @("Cert:/LocalMachine/Root", "Cert:/CurrentUser/Root", "Cert:/LocalMachine/CA", "Cert:/CurrentUser/CA")',
    '$seen = @{}',
    '$sb = New-Object System.Text.StringBuilder',
    'foreach ($s in $stores) { foreach ($c in (Get-ChildItem $s -ErrorAction SilentlyContinue)) {',
    '  if ($seen.ContainsKey($c.Thumbprint)) { continue }; $seen[$c.Thumbprint] = 1',
    '  [void]$sb.AppendLine("-----BEGIN CERTIFICATE-----")',
    '  [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData, "InsertLineBreaks"))',
    '  [void]$sb.AppendLine("-----END CERTIFICATE-----") } }',
    `[IO.File]::WriteAllText("${file.replace(/"/g, '`"')}", $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))`,
    'Write-Output $seen.Count',
  ].join('\n');
  // -EncodedCommand (UTF-16LE base64): sin problemas de comillas ni barras.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`no se pudo exportar el almacén de certificados: ${r.stderr || r.error?.message}`);
  return file;
}

function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  let own = sep >= 0 ? argv.slice(0, sep) : [];
  let cmd = sep >= 0 ? argv.slice(sep + 1) : argv;
  if (sep < 0) {
    // sin '--': las opciones propias son los primeros argumentos que empiezan con '--'
    const i = cmd.findIndex((a) => !a.startsWith('--'));
    own = i < 0 ? cmd : cmd.slice(0, i);
    cmd = i < 0 ? [] : cmd.slice(i);
  }
  const file = exportCa(join(cpHome(), 'ca.pem'), own.includes('--refresh'));
  if (!cmd.length) {
    console.log(file);
    return;
  }
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: file };
  let [bin, ...args] = cmd;
  // `node` → el mismo ejecutable, sin shell (evita problemas de comillas en Windows).
  if (bin === 'node') bin = process.execPath;
  const run = (shell) => spawn(bin, args, { stdio: 'inherit', env, shell, windowsHide: false });
  let child = run(false);
  child.on('error', (e) => {
    if (e.code !== 'ENOENT' || process.platform !== 'win32') {
      console.error(`with-ca: ${e.message}`);
      process.exit(1);
    }
    // npm, npx, tsx... son .cmd en Windows: reintento vía shell.
    child = run(true);
    child.on('exit', (code) => process.exit(code ?? 1));
  });
  child.on('exit', (code) => process.exit(code ?? 1));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => child.kill(sig));
}

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
