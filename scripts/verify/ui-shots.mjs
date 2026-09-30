#!/usr/bin/env node
// CP-059: capturas del dashboard con datos SINTÉTICOS. Levanta un daemon propio (puerto y carpeta
// temporales, nunca el real), lo siembra con N sesiones (transcripts de Claude Code y Codex en
// carpetas temporales + eventos web/Gemini por la API) y corre la app desktop en modo --smoke.
//
// Uso:
//   node scripts/verify/ui-shots.mjs --sessions 4 --out docs/reports/ui-live --prefix 4-light- \
//     [--theme light|dark] [--size 1280x800] [--tabs live,sessions-detail,settings-info,team] [--port 47911]
//
// Requiere `node apps/desktop/build.mjs` antes. No toca %LOCALAPPDATA%\ContextPilot ni ~/.claude.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? '1' : (all[i + 1] ?? '1')]] : acc), []),
);
const N = Number(args.sessions ?? 4);
const out = resolve(root, args.out ?? 'docs/reports/ui-live');
const port = Number(args.port ?? 47911);
const MIN = 60_000;
mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), 'cp-ui-'));
const projects = join(home, 'claude-projects');
const codexRoot = join(home, 'codex-sessions');
mkdirSync(projects, { recursive: true });
mkdirSync(codexRoot, { recursive: true });
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Uso del plan (formato de Claude Desktop): 5 h subiendo rápido → R10 proyecta agotamiento.
const planFile = join(home, 'plan-usage-history.json');
const fh = [40, 52, 64, 78];
writeFileSync(
  planFile,
  JSON.stringify({ version: 2, samples: fh.map((v, i) => ({ t: now - (fh.length - 1 - i) * 15 * MIN - 60_000, org: 'org-demo', u: { fh: v, sd: 31 + i } })) }),
);

const env = {
  ...process.env,
  CONTEXTPILOT_HOME: home,
  CONTEXTPILOT_PORT: String(port),
  CONTEXTPILOT_CLAUDE_PROJECTS: projects,
  CONTEXTPILOT_CODEX_SESSIONS: codexRoot,
  CONTEXTPILOT_PLAN_USAGE_FILE: planFile,
};

// ---------------------------------------------------------------- transcripts sintéticos

const VERSION = '2.1.200';
function claudeWriter(project, sessionId) {
  const dir = join(projects, `c--demo-${project}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  const cwd = `C:\\Users\\demo\\${project}`;
  const lines = [];
  let msg = 0;
  const base = { sessionId, cwd, version: VERSION, entrypoint: 'cli' };
  return {
    file,
    title: (t) => lines.push({ type: 'ai-title', aiTitle: t, sessionId }),
    user: (ts, text) => lines.push({ ...base, type: 'user', timestamp: iso(ts), message: { role: 'user', content: text } }),
    toolResult: (ts, id, text, isError = false) =>
      lines.push({ ...base, type: 'user', timestamp: iso(ts), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } }),
    assistant: (ts, model, ctx, { output = 400, cacheRatio = 0.9, tool, side = false } = {}) => {
      msg++;
      const input = 20;
      const cacheRead = Math.round((ctx - output - input) * cacheRatio);
      const cacheWrite = ctx - output - input - cacheRead;
      const content = tool ? [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }] : [{ type: 'text', text: 'ok' }];
      lines.push({
        ...base,
        ...(side ? { isSidechain: true } : {}),
        type: 'assistant',
        timestamp: iso(ts),
        message: {
          id: `msg_${sessionId.slice(0, 8)}_${msg}`,
          model,
          role: 'assistant',
          content,
          usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, cache_creation: { ephemeral_5m_input_tokens: cacheWrite } },
        },
      });
    },
    flush: () => appendFileSync(file, lines.splice(0).map((l) => JSON.stringify(l)).join('\n') + '\n'),
  };
}

const OPUS = 'claude-opus-4-5';
const SONNET = 'claude-sonnet-4-5';

const scenarios = [
  // 1. contextpilot: sesión larga con ráfagas de subagentes; R1 al cruzar 60 % (ámbar + coaching).
  () => {
    const w = claudeWriter('contextpilot', randomUUID());
    w.title('Monitor en vivo del dashboard');
    let t = now - 38.5 * MIN;
    w.user(t, 'Implementá el monitor en vivo con una tarjeta por sesión activa y coaching por regla');
    for (let i = 0; i < 110; i++) {
      t += 20_000;
      const ctx = 22_000 + Math.round((i / 110) * 94_000); // hasta ~58 %
      w.assistant(t, OPUS, ctx);
      if (i % 30 === 10) {
        // ráfaga de subagente: contexto propio chico (no debe dibujarse en el timeline)
        for (let k = 0; k < 8; k++) w.assistant(t + k * 1500, SONNET, 4000 + k * 1800, { side: true, output: 300 });
      }
    }
    t += 25_000;
    w.assistant(t, OPUS, 136_000); // 68 % → R1
    w.flush();
    return w.file;
  },
  // 2. automation-api-sportsbook: sana, caché alta; última actividad hace 2 min → cuenta regresiva de caché.
  () => {
    const w = claudeWriter('automation-api-sportsbook', randomUUID());
    w.title('Tests de apuestas combinadas');
    let t = now - 20 * MIN;
    w.user(t, 'Agregá casos de borde para parlays con cuotas empatadas y límites de apuesta');
    for (let i = 0; i < 12; i++) {
      t = now - 20 * MIN + i * 90_000;
      w.assistant(t, SONNET, 40_000 + i * 2500, { cacheRatio: 0.93 });
    }
    w.flush();
    return w.file;
  },
  // 3. Codex (qa-lead-assistant): 55 % de 272k → ámbar sin sugerencia, consejo «cuando pase 60 %…».
  () => {
    const id = randomUUID();
    const dir = join(codexRoot, '2026', '09', '30');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-09-30T12-00-00-${id}.jsonl`);
    const L = [];
    let t = now - 7 * MIN;
    L.push({ timestamp: iso(t), type: 'session_meta', payload: { id, timestamp: iso(t), cwd: 'C:\\Users\\demo\\qa-lead-assistant', originator: 'codex_cli_rs', cli_version: '0.42.0' } });
    L.push({ timestamp: iso(t + 100), type: 'turn_context', payload: { cwd: 'C:\\Users\\demo\\qa-lead-assistant', model: 'gpt-5-codex' } });
    L.push({ timestamp: iso(t + 200), type: 'event_msg', payload: { type: 'user_message', message: 'Resumí los bugs abiertos del sprint por equipo y severidad', images: [] } });
    let total = 0;
    for (let i = 0; i < 6; i++) {
      t += 60_000;
      const inp = 90_000 + i * 11_000;
      total += inp + 800;
      L.push({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 800, reasoning_output_tokens: 100, total_tokens: total }, last_token_usage: { input_tokens: inp, cached_input_tokens: Math.round(inp * 0.85), output_tokens: 800, reasoning_output_tokens: 100, total_tokens: inp + 800 }, model_context_window: 272_000 } } });
    }
    writeFileSync(file, L.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  },
  // 4. Web claude.ai: conversación larga → W1 (ámbar + coaching). Se envía por la API.
  'web-long',
  // 5. backend-for-testing-explorer: agente en loop (R8, rojo).
  () => {
    const w = claudeWriter('backend-for-testing-explorer', randomUUID());
    w.title('Arreglar el seed de la base de pruebas');
    let t = now - 6 * MIN;
    w.user(t, 'Corré el seed de la base de pruebas y arreglá lo que falle');
    const input = { command: 'npm run seed -- --env=qa' };
    for (let i = 1; i <= 3; i++) {
      t += 20_000;
      w.assistant(t, SONNET, 60_000 + i * 1500, { tool: { id: `tu_${i}`, name: 'Bash', input } });
      w.toolResult(t + 5000, `tu_${i}`, 'Error: connect ECONNREFUSED 127.0.0.1:5432', true);
    }
    w.assistant(t + 15_000, SONNET, 66_000);
    w.flush();
    return w.file;
  },
  // 6. Gemini CLI por la API sin adaptador activo → «sin datos» (gris).
  'gemini-nodata',
  // 7. propshopx-qa: salida de herramienta enorme (R5, info).
  () => {
    const w = claudeWriter('propshopx-qa', randomUUID());
    w.title('Revisar logs del job nocturno');
    let t = now - 9 * MIN;
    w.user(t, 'Leé el log del job nocturno y decime por qué se cayó');
    w.assistant(t + 10_000, SONNET, 30_000, { tool: { id: 'tu_log', name: 'Read', input: { file_path: 'C:\\logs\\nightly.log' } } });
    w.toolResult(t + 15_000, 'tu_log', 'linea de log 2026-09-30 job nightly paso ok '.repeat(1400));
    w.assistant(t + 25_000, SONNET, 45_000);
    w.flush();
    return w.file;
  },
  // 8. Web ChatGPT: conversación chica y sana (verde, consejo).
  'web-small',
  // 9. txodds-setup: pregunta simple en Opus (R7, info).
  () => {
    const w = claudeWriter('txodds-setup', randomUUID());
    w.title('Pregunta rápida sobre Pulsar');
    const t = now - 3 * MIN;
    w.user(t, '¿qué puerto usa pulsar por defecto?');
    w.assistant(t + 8000, OPUS, 18_000, { output: 120 });
    w.flush();
    return w.file;
  },
];

function webEvents(kind) {
  const base = { provider: 'anthropic', turn: 22, idleSincePrevMs: 60_000, promptHash: '', phase: 'response' };
  if (kind === 'web-long') {
    return [{ ...base, source: 'web', client: 'claude.ai', sessionId: `claude.ai:${randomUUID()}`, ts: iso(now - 4 * MIN), model: 'claude-sonnet-4-5', title: 'Plan de pruebas de regresión', tokens: { input: 93_000, output: 2000, estimated: true }, contextSize: 95_000, contextWindow: 200_000 }];
  }
  if (kind === 'web-small') {
    return [{ ...base, provider: 'openai', source: 'web', client: 'chatgpt.com', turn: 4, sessionId: `chatgpt.com:${randomUUID()}`, ts: iso(now - 12 * MIN), model: 'gpt-4o', title: 'Resumen de incidentes de la semana', tokens: { input: 11_000, output: 900, estimated: true }, contextSize: 11_900, contextWindow: 128_000 }];
  }
  return [{ ...base, provider: 'google', source: 'gemini-cli', client: 'gemini-cli', turn: 3, sessionId: randomUUID(), ts: iso(now - 7 * MIN), model: 'gemini-2.5-pro', tokens: { input: 30_000, output: 800, cacheRead: 0, estimated: false }, contextSize: 30_800, contextWindow: 1_048_576 }];
}

// ---------------------------------------------------------------- daemon

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daemon = spawn(process.execPath, ['--import', 'tsx', join(root, 'apps/daemon/src/main.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let daemonLog = '';
daemon.stdout.on('data', (d) => (daemonLog += d));
daemon.stderr.on('data', (d) => (daemonLog += d));
const kill = () => {
  try {
    daemon.kill();
  } catch {
    /* ya salió */
  }
};
process.on('exit', kill);

const base = `http://127.0.0.1:${port}`;
async function api(method, path, body) {
  const token = readFileSync(join(home, 'token'), 'utf8').trim();
  const r = await fetch(base + path, { method, headers: { 'x-cp-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok && existsSync(join(home, 'token'))) break;
    } catch {
      /* todavía no */
    }
    await sleep(200);
  }
  await sleep(800);
  const files = [];
  for (const sc of scenarios.slice(0, N)) {
    if (typeof sc === 'function') files.push(sc());
    else await api('POST', '/ingest/events', webEvents(sc));
  }
  // Los tailers ven los archivos por fs.watch; el hook Stop acelera (igual que en uso real).
  for (const f of files.filter((f) => f.endsWith('.jsonl') && f.startsWith(projects))) {
    const sid = f.split(/[\\/]/).pop().replace('.jsonl', '');
    await api('POST', '/ingest/hooks/Stop', { session_id: sid, transcript_path: f });
  }
  for (let i = 0; i < 40; i++) {
    const s = await api('GET', '/sessions?active=true');
    if (s.length >= N) break;
    await sleep(250);
  }
  await sleep(1500);
  const sessions = await api('GET', '/sessions?active=true');
  console.log(`sesiones activas: ${sessions.length}`);
  for (const s of sessions) console.log(`  ${s.displayName}  (${s.source}, ${Math.round(s.contextPct * 100)} %)${s.suggestion ? ` → ${s.suggestion.ruleId}` : ''}`);

  const smokeEnv = {
    ...env,
    CONTEXTPILOT_SMOKE_PREFIX: args.prefix ?? '',
    CONTEXTPILOT_SMOKE_THEME: args.theme ?? 'light',
    CONTEXTPILOT_SMOKE_SIZE: args.size ?? '1280x800',
    CONTEXTPILOT_SMOKE_TABS: args.tabs ?? '',
    CONTEXTPILOT_SMOKE_PICK: args.pick ?? 'contextpilot',
  };
  const code = await new Promise((res) => {
    const c = spawn(process.execPath, [join(root, 'apps/desktop/scripts/start.mjs'), '--smoke', `--smoke-shot=${out}`], { cwd: root, env: smokeEnv, stdio: 'inherit' });
    c.on('exit', (x) => res(x ?? 1));
  });
  if (code !== 0) throw new Error(`smoke salió con ${code}`);
} catch (e) {
  console.error(String(e));
  console.error(daemonLog.slice(-2000));
  process.exitCode = 1;
} finally {
  kill();
  await sleep(500);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* archivos aún abiertos: queda en %TEMP% */
  }
}
