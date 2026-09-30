#!/usr/bin/env node
// CP-053: traspaso CLI sin UI Electron.
//   node scripts/handoff.mjs <sessionId|--latest> [--copy | --print]
// --copy coloca en el portapapeles el traspaso + instrucción del comando de limpieza del cliente
// (PowerShell Set-Clipboard, UTF-8 preservado vía base64). --print (default) imprime a stdout.
import { spawnSync } from 'node:child_process';
import { cpBase, cpToken } from './lib/cp.mjs';

const CLI = new Set(['claude-code', 'codex', 'gemini-cli']);

async function api(path, init = {}) {
  const r = await fetch(`${cpBase()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-cp-token': cpToken(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(90_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export function composeClipboard(summary, command) {
  const tail = command
    ? `\n\n---\nPara continuar: ejecutá ${command} en la sesión actual y pegá este traspaso como primer mensaje.`
    : '\n\n---\nPara continuar: abrí una conversación nueva y pegá este traspaso como primer mensaje.';
  return summary + tail;
}

export function setClipboard(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '$b=[Console]::In.ReadToEnd(); Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b.Trim())))'],
    { input: b64, encoding: 'utf8', windowsHide: true },
  );
  if (ps.status !== 0) throw new Error(`Set-Clipboard falló: ${ps.stderr || ps.error?.message}`);
}

async function main() {
  const args = process.argv.slice(2);
  const copy = args.includes('--copy');
  let sessionId = args.find((a) => !a.startsWith('--'));
  if (!sessionId || args.includes('--latest')) {
    const sessions = await api('/sessions?active=true');
    const s = sessions.find((x) => CLI.has(x.source));
    if (!s) throw new Error('no hay sesiones CLI activas');
    sessionId = s.sessionId;
  }
  const r = await api('/handoff', { method: 'POST', body: JSON.stringify({ sessionId }) });
  const text = composeClipboard(r.summary, r.command);
  if (copy) {
    setClipboard(text);
    console.log(`Traspaso copiado al portapapeles (${r.method}, sesión ${sessionId}).${r.command ? ` Ejecutá ${r.command} y pegalo.` : ''}`);
  } else {
    process.stdout.write(text + '\n');
  }
}

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`ContextPilot: ${e.message}`);
    process.exit(1);
  });
}
