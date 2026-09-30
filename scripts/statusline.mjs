#!/usr/bin/env node
// CP-045: statusline de Claude Code. Lee el JSON de stdin (session_id), pide GET /statusline/:id
// con 300 ms de tope e imprime la línea. Daemon caído o lento → «ContextPilot: sin datos», exit 0.
import { cpBase, cpToken, readStdin } from './lib/cp.mjs';

const TIMEOUT_MS = 300;
const FALLBACK = 'ContextPilot: sin datos';

async function main() {
  const raw = await readStdin(TIMEOUT_MS);
  let sessionId = '';
  try {
    sessionId = String(JSON.parse(raw).session_id ?? '');
  } catch {
    return FALLBACK;
  }
  if (!sessionId) return FALLBACK;
  const r = await fetch(`${cpBase()}/statusline/${encodeURIComponent(sessionId)}`, {
    headers: { 'x-cp-token': cpToken() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) return FALLBACK;
  const text = (await r.text()).split('\n')[0].trim();
  return text || FALLBACK;
}

main()
  .catch(() => FALLBACK)
  .then((line) => {
    process.stdout.write(`${line}\n`);
    process.exit(0);
  });
