#!/usr/bin/env node
// CP-032: reenvía el JSON de stdin de un hook de Claude Code al daemon.
// RNF-08: SIEMPRE sale con código 0, sin escribir nada a stdout/stderr (no inyecta contexto ni bloquea).
// Uso (lo configura install-hooks.mjs): node scripts/hook.mjs <HookName>
import { cpBase, cpToken, readStdin } from './lib/cp.mjs';

const TIMEOUT_MS = 1000;

async function main() {
  // Los `claude -p` que lanza el propio traspaso no se reenvían.
  if (process.env.CONTEXTPILOT_HANDOFF === '1') return;
  const name = (process.argv[2] ?? '').replace(/[^A-Za-z]/g, '');
  const input = await readStdin(TIMEOUT_MS);
  const body = input.trim();
  if (!body) return;
  let hookName = name;
  if (!hookName) {
    try {
      hookName = String(JSON.parse(body).hook_event_name ?? '').replace(/[^A-Za-z]/g, '');
    } catch {
      return;
    }
  }
  if (!hookName) return;
  await fetch(`${cpBase()}/ingest/hooks/${hookName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cp-token': cpToken() },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then((r) => r.arrayBuffer());
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
