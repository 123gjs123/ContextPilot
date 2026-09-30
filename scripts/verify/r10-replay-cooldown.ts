// Verificación (aceptación ronda 2, observación (a) del lead / D-19x): ¿por qué R10 no publica con la
// proyección de /account mostrando agotamiento antes del fin de ventana?
//
// Hipótesis: al arrancar, el tailer re-procesa transcripts de los últimos 30 min en modo `replay`.
// En replay el pipeline evalúa con `now = ts del evento` (pasado), R10 "dispara", el motor fija el
// cooldown de `account:anthropic:R10` (60 min desde el ts viejo) y el pipeline descarta la sugerencia
// porque ya expiró. Resultado: R10 queda silenciada hasta ~1 h después del evento viejo, sin haberse
// mostrado nunca.
//
// Uso: npx tsx scripts/verify/r10-replay-cooldown.ts
// Daemon propio (puerto libre, home temporal, carpeta de proyectos temporal, plan-usage sintético).
// No toca %LOCALAPPDATA%\ContextPilot ni ~/.claude.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../apps/daemon/src/daemon.js';

const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hotPlanUsage(file: string): void {
  const now = Date.now();
  const fh = [10, 18, 26, 34, 42, 50, 58];
  writeFileSync(file, JSON.stringify({ version: 2, samples: fh.map((v, i) => ({ t: now - (fh.length - 1 - i) * 15 * MIN - MIN, org: 'o', u: { fh: v, sd: 20 } })) }));
}

function assistantLine(sid: string, id: string, ts: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      sessionId: sid,
      version: '2.1.284',
      timestamp: ts,
      uuid: `a-${id}`,
      message: {
        id,
        model: 'claude-sonnet-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100, output_tokens: 50 },
      },
    }) + '\n'
  );
}

async function scenario(name: string, withOldLine: boolean): Promise<{ afterStart: string[]; afterLive: string[] }> {
  const root = mkdtempSync(join(tmpdir(), 'cp-r10-'));
  const home = join(root, 'home');
  const projects = join(root, 'projects');
  const proj = join(projects, 'C--repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { geminiOutfile: join(root, 'telemetry.log') } }));
  const planFile = join(root, 'plan-usage-history.json');
  hotPlanUsage(planFile);
  const sid = '11111111-2222-3333-4444-555555555555';
  const file = join(proj, `${sid}.jsonl`);
  // Evento de hace 20 min (dentro de recentMs = 30 min → se re-procesa en replay al arrancar).
  writeFileSync(file, withOldLine ? assistantLine(sid, 'msg_old', new Date(Date.now() - 20 * MIN).toISOString()) : '');
  const env = { ...process.env, CONTEXTPILOT_PLAN_USAGE_FILE: planFile };
  delete env.NODE_EXTRA_CA_CERTS;
  const d = await startDaemon({ home, port: 0, quiet: true, env, claudeProjectsDir: projects, codexSessionsDir: join(root, 'codex'), claudeBin: () => null, rescanMs: 60_000, rootRetryMs: 200 });
  const base = `http://127.0.0.1:${d.port}`;
  const account = async () =>
    ((await (await fetch(`${base}/account`, { headers: { 'x-cp-token': d.token } })).json()) as { suggestions: { ruleId: string }[]; burn: { projections: { exhaustAt?: number }[] }[] });
  try {
    await d.ready();
    await sleep(500);
    const a1 = await account();
    appendFileSync(file, assistantLine(sid, 'msg_live', new Date().toISOString()));
    await sleep(1500);
    const a2 = await account();
    const proj5h = a2.burn[0]?.projections[0];
    console.log(
      `${name}: exhaustAt proyectado=${proj5h?.exhaustAt ? new Date(proj5h.exhaustAt).toTimeString().slice(0, 5) : '—'} · ` +
        `R10 tras arranque=${JSON.stringify(a1.suggestions.map((s) => s.ruleId))} · tras evento en vivo=${JSON.stringify(a2.suggestions.map((s) => s.ruleId))}`,
    );
    return { afterStart: a1.suggestions.map((s) => s.ruleId), afterLive: a2.suggestions.map((s) => s.ruleId) };
  } finally {
    await d.close();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows */
    }
  }
}

const control = await scenario('control (sin evento viejo)', false);
const bug = await scenario('con evento de hace 20 min en replay', true);
const ok = control.afterLive.includes('R10') && bug.afterLive.includes('R10');
console.log(ok ? 'OK: R10 publica en vivo en ambos escenarios' : 'FALLA: R10 no publica en vivo cuando hubo un evento viejo en el replay de arranque');
process.exit(ok ? 0 : 1);
