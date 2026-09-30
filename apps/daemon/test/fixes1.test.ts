import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { R5, RuleEngine, applyEvent, type Suggestion } from '@contextpilot/core';
import { defaultDaemonConfig, lastValidPath, loadConfig, saveConfig } from '../src/config.js';
import { HealthRegistry } from '../src/health.js';
import { nullLogger } from '../src/log.js';
import { Pipeline } from '../src/pipeline.js';
import { originAllowed, statuslineText } from '../src/server.js';
import { Storage } from '../src/storage.js';
import { ev, rmrf, startTestDaemon, tempDir, waitFor, wsClient, type TestDaemon } from './helpers.js';

// Defectos D-1, D-2, D-3, D-5, D-9, D-11, D-15, D-16, D-18 (docs/ACCEPTANCE.md §4) a nivel daemon.

const MIN = 60_000;
const open: TestDaemon[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  for (const d of dirs.splice(0)) rmrf(d);
});
async function daemon(over: Parameters<typeof startTestDaemon>[0] = {}) {
  const t = await startTestDaemon(over);
  open.push(t);
  return t;
}
const big = (sessionId: string, over = {}) =>
  ev({ sessionId, contextSize: 130_000, tokens: { input: 100, output: 100, cacheRead: 129_800, cacheWrite: 0, estimated: false }, ...over });

/** plan-usage-history.json con ritmo que agota la ventana de 5 h. */
function hotPlanUsage(dir: string): string {
  const now = Date.now();
  const fh = [10, 18, 26, 34, 42, 50, 58, 66, 74];
  const file = join(dir, 'plan-usage-history.json');
  writeFileSync(file, JSON.stringify({ version: 2, samples: fh.map((v, i) => ({ t: now - (fh.length - 1 - i) * 15 * MIN - MIN, org: 'o', u: { fh: v, sd: 20 } })) }));
  return file;
}

describe('D-1: R10 de cuenta no tapa a R1 (con plan-usage real simulado)', () => {
  it('50 sesiones nuevas: R1 visible en las 50; R10 publicado UNA vez como account:anthropic', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const t = await daemon({ env: { ...process.env, CONTEXTPILOT_PLAN_USAGE_FILE: hotPlanUsage(dir) } });
    const c = await wsClient(t.base, t.token);
    await c.next((m) => m.type === 'hello');
    for (let i = 0; i < 50; i++) {
      const sid = `D1-${i}`;
      const p = c.next((m) => m.type === 'suggestion' && m.data.sessionId === sid && m.data.ruleId === 'R1', 2000);
      await t.api('/ingest/events', { method: 'POST', json: [big(sid)] });
      expect((await p).data.severity).toBe('warn');
    }
    const r10 = c.msgs.filter((m) => m.type === 'suggestion' && m.data.ruleId === 'R10');
    expect(r10).toHaveLength(1);
    expect(r10[0].data.sessionId).toBe('account:anthropic');
    // /account y statusline muestran el aviso de cuenta aparte.
    const acc = (await (await t.api('/account')).json()) as { suggestions: Suggestion[] };
    expect(acc.suggestions.map((s) => s.ruleId)).toEqual(['R10']);
    const line = await (await t.api('/statusline/D1-7')).text();
    expect(line).toMatch(/^ctx 65% · cache 100% · ⚠ \/compact · ⏳ límite \d\d:\d\d$/);
    c.close();
  }, 30_000);
});

describe('D-2: /compact <foco> desde el transcript en memoria, sin persistir el foco', () => {
  it('R1 de Claude Code llega por WS con foco; cp.db no contiene los nombres de archivo', async () => {
    const t = await daemon();
    mkdirSync(t.dirs.claude, { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    const proj = join(t.dirs.claude, 'C--repo');
    mkdirSync(proj, { recursive: true });
    const sid = 'aaaaaaaa-2222-3333-4444-555555555555';
    const c = await wsClient(t.base, t.token);
    await c.next((m) => m.type === 'hello');
    const ts = (o: number) => new Date(Date.now() + o).toISOString();
    const L = (o: object) => JSON.stringify({ sessionId: sid, version: '2.1.0', ...o }) + '\n';
    const usage = (cr: number) => ({ input_tokens: 10, cache_read_input_tokens: cr, cache_creation_input_tokens: 0, output_tokens: 50 });
    writeFileSync(
      join(proj, `${sid}.jsonl`),
      L({ type: 'user', timestamp: ts(0), message: { role: 'user', content: 'arreglá el motor de reglas por favor, gracias' } }) +
        L({ type: 'assistant', timestamp: ts(1), message: { id: 'm1', model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'C:\\repo\\src\\archivoSecretoFoco.ts' } }], usage: usage(20_000) } }) +
        L({ type: 'user', timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }) +
        L({ type: 'assistant', timestamp: ts(3), message: { id: 'm2', model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'listo' }], usage: usage(125_000) } }),
    );
    const m = await c.next((x) => x.type === 'suggestion' && x.data.ruleId === 'R1' && x.data.sessionId === sid, 5000);
    const copy = m.data.actions.find((a: any) => a.kind === 'copy');
    expect(copy.payload).toMatch(/^\/compact Conservá el trabajo sobre archivoSecretoFoco\.ts \(Edit\)/);
    // Lecturas por API ven la versión con foco (en memoria).
    const list = (await (await t.api(`/suggestions?sessionId=${sid}&active=true`)).json()) as Suggestion[];
    expect(list[0]!.actions.find((a) => a.kind === 'copy')!.payload).toContain('archivoSecretoFoco.ts');
    // Statusline: acción corta, sin foco.
    expect(await (await t.api(`/statusline/${sid}`)).text()).toContain('⚠ /compact');
    // RNF-01: el foco no se persiste.
    t.d.storage.flush();
    expect(readFileSync(join(t.home, 'cp.db')).includes('archivoSecretoFoco')).toBe(false);
    c.close();
  }, 20_000);
});

describe('D-3: statusline con acción corta por regla', () => {
  const view = {
    sessionId: 's', source: 'claude-code' as const, provider: 'anthropic' as const, client: 'cli', model: 'm', turns: 1,
    contextSize: 56_000, contextWindow: 200_000, contextPct: 0.28, cachePct: 0.99, estimated: false, lastTurnAt: '', status: 'active' as const,
  };
  it('R5 visible → «⚠ grep/head» (antes: «⚠ Para»)', () => {
    const e = ev({ toolCalls: [{ name: 'Read', resultTokens: 30_000, failed: false, argsHash: '' }] });
    const res = R5.evaluate({ event: e, state: applyEvent(undefined, e), thresholds: { ...R5.defaults }, now: 0 })!;
    const s = { id: 'x', ruleId: 'R5', sessionId: 's', expiresAt: '', ...res } as Suggestion;
    expect(statuslineText(view, s, false)).toBe('ctx 28% · cache 99% · ⚠ grep/head');
  });
  it('R8 → «⚠ loop!»; con aviso de cuenta sigue ≤ 80 columnas', () => {
    const r8 = { id: 'x', ruleId: 'R8', sessionId: 's', severity: 'critical', title: 'Agente en loop', detail: '', expiresAt: '', actions: [{ kind: 'show-detail', label: 'Ver' }] } as Suggestion;
    const r10 = { ...r8, ruleId: 'R10', title: 'A este ritmo llegás al límite a las 12:58 (ventana de 7 d)' } as Suggestion;
    const line = statuslineText(view, r8, false, r10);
    expect(line).toBe('ctx 28% · cache 99% · ⚠ loop! · ⏳ límite 12:58');
    expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe('D-9: ids de extensión permitidos', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  it('originAllowed: sin lista, cualquier extensión; con lista, sólo esas', () => {
    expect(originAllowed(`chrome-extension://${B}`)).toBe(true);
    expect(originAllowed(`chrome-extension://${B}`, [A])).toBe(false);
    expect(originAllowed(`chrome-extension://${A}`, [A])).toBe(true);
    expect(originAllowed('https://evil.example', [A])).toBe(false);
    expect(originAllowed(undefined, [A])).toBe(true);
  });
  it('config vacía → aviso en /health; con id configurado → otro id 403 (HTTP y WS)', async () => {
    const t = await daemon();
    const h = (await (await fetch(`${t.base}/health`)).json()) as { name: string; detail?: string }[];
    expect(h.find((x) => x.name === 'origin')?.detail).toContain('allowedExtensionIds vacío');
    expect((await t.api('/sessions', { headers: { origin: `chrome-extension://${B}` } })).status).toBe(200);
    expect((await t.api('/config', { method: 'PUT', json: { daemon: { allowedExtensionIds: [A] } } })).status).toBe(200);
    expect((await t.api('/sessions', { headers: { origin: `chrome-extension://${B}` } })).status).toBe(403);
    expect((await t.api('/sessions', { headers: { origin: `chrome-extension://${A}` } })).status).toBe(200);
    expect(t.d.health.get('origin')?.detail).toBe('extensiones permitidas: 1');
    expect((await t.api('/config', { method: 'PUT', json: { daemon: { allowedExtensionIds: ['no-es-un-id'] } } })).status).toBe(400);
  });
});

describe('D-5: ritmo y proyección expuestos', () => {
  it('SessionView.burn en /sessions y /stats.burn por proveedor con proyección de plan (5 h + 7 d)', async () => {
    const t = await daemon();
    await t.api('/config', {
      method: 'PUT',
      json: { plans: [{ provider: 'anthropic', kind: 'subscription', windows: [{ hours: 5, limit: 2_000_000 }, { days: 7, limit: 50_000_000 }] }] },
    });
    for (let i = 0; i < 3; i++) await t.api('/ingest/events', { method: 'POST', json: [big('B1', { ts: new Date(Date.now() - (2 - i) * MIN).toISOString() })] });
    const views = (await (await t.api('/sessions?active=true')).json()) as { sessionId: string; burn: { tokensPerMin: number } }[];
    expect(views.find((v) => v.sessionId === 'B1')!.burn.tokensPerMin).toBe(Math.round((3 * 130_000) / 15));
    const stats = (await (await t.api('/stats')).json()) as { burn: { provider: string; tokensPerMin: number; projections: { window: string; pct: number }[]; source: string }[] };
    const a = stats.burn.find((b) => b.provider === 'anthropic')!;
    expect(a.tokensPerMin).toBeGreaterThan(0);
    expect(a.source).toBe('local');
    expect(a.projections.map((p) => p.window)).toEqual(['5h', '168h']);
    expect(a.projections[0]!.pct).toBeGreaterThan(0);
  });
});

describe('D-15: config inválida → última válida (CP-054.4)', () => {
  it('se usa config.json.last-valid y health lo informa', () => {
    const dir = tempDir();
    dirs.push(dir);
    const file = join(dir, 'config.json');
    const good = defaultDaemonConfig();
    good.rules.R1!.thresholds.pct = 0.42;
    saveConfig(file, good);
    writeFileSync(file, JSON.stringify({ rules: { R1: { enabled: 'si' } } }));
    const r = loadConfig(file);
    expect(r.config.rules.R1!.thresholds.pct).toBe(0.42);
    expect(r.error).toContain('última válida');
    // El archivo inválido no se pisa.
    expect(readFileSync(file, 'utf8')).toContain('"si"');
    // Sin copia válida → defaults.
    rmrf(lastValidPath(file));
    const r2 = loadConfig(file);
    expect(r2.config.rules.R1!.thresholds.pct).toBe(0.6);
    expect(r2.error).toContain('por defecto');
  });
  it('plan con windows se valida (CP-055.1)', async () => {
    const t = await daemon();
    const bad = await t.api('/config', { method: 'PUT', json: { plans: [{ provider: 'anthropic', kind: 'subscription', windows: [{ hours: 5 }] }] } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('limit');
  });
});

describe('D-16: rehidratación profunda tras reinicio (CP-007.4)', () => {
  it('el estado de sesión después de reiniciar es idéntico', async () => {
    const t = await startTestDaemon();
    const events = [
      big('RH', { ts: new Date(Date.now() - 3 * MIN).toISOString(), toolCalls: [{ name: 'Bash', resultTokens: 12, failed: true, argsHash: 'h' }] }),
      ev({ sessionId: 'RH', phase: 'prompt', ts: new Date(Date.now() - 2 * MIN).toISOString(), tokens: { input: 0, output: 0, estimated: false }, contextSize: 0, blocks: [{ hash: 'B', tokens: 3000 }] }),
      big('RH', { ts: new Date(Date.now() - MIN).toISOString(), cacheTtlMs: 3_600_000 }),
    ];
    await t.api('/ingest/events', { method: 'POST', json: events });
    const before = structuredClone(t.d.pipeline.getSession('RH'));
    t.d.storage.flush();
    const home = t.home;
    await t.d.close();
    const t2 = await startTestDaemon({ home });
    open.push(t2);
    dirs.push(home);
    expect(t2.d.pipeline.getSession('RH')).toEqual(before);
  });
});

describe('pipeline con temporizadores (D-11, D-18)', () => {
  let storage: Storage;
  let pipe: Pipeline;
  const seen: Suggestion[] = [];
  beforeEach(async () => {
    storage = await Storage.open(null);
    vi.useFakeTimers({ now: new Date('2026-09-30T12:00:00Z') });
    const cfg = defaultDaemonConfig();
    pipe = new Pipeline(storage, new RuleEngine(cfg), new HealthRegistry(), () => cfg, nullLogger);
    seen.length = 0;
    pipe.on('suggestion', (s) => seen.push(s));
  });
  afterEach(() => {
    pipe.dispose();
    vi.useRealTimers();
    storage.close();
  });

  it('D-18: R2 proactivo y luego el prompt que cierra la pausa → una sola emisión', () => {
    pipe.ingest([big('P', { ts: new Date().toISOString(), cacheTtlMs: 5 * MIN })]);
    vi.advanceTimersByTime(5 * MIN + 2000);
    expect(seen.filter((s) => s.ruleId === 'R2')).toHaveLength(1);
    // Vuelve 40 min después (fuera del cooldown de 30 min): mismo corte de caché, no se repite.
    vi.advanceTimersByTime(35 * MIN);
    pipe.ingest([ev({ sessionId: 'P', phase: 'prompt', ts: new Date().toISOString(), tokens: { input: 0, output: 0, estimated: false }, contextSize: 0 })]);
    pipe.ingest([big('P', { ts: new Date().toISOString(), tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 129_800, estimated: false } })]);
    expect(seen.filter((s) => s.ruleId === 'R2')).toHaveLength(1);
  });

  const upload = (sessionId: string, client = 'claude.ai') =>
    ev({ sessionId, source: 'web', client, ts: new Date().toISOString(), attachments: [{ hash: 'ADJ', tokens: 4000 }], tokens: { input: 5000, output: 10, estimated: true }, contextSize: 5000 });

  it('D-11: W2 detecta la re-subida en OTRA conversación del mismo sitio (7 días), no en otro sitio', () => {
    pipe.ingest([upload('claude.ai:conv-1')]);
    expect(seen.filter((s) => s.ruleId === 'W2')).toHaveLength(0);
    pipe.ingest([upload('chatgpt.com:conv-x', 'chatgpt.com')]);
    expect(seen.filter((s) => s.ruleId === 'W2')).toHaveLength(0);
    vi.advanceTimersByTime(2 * 86_400_000);
    pipe.ingest([upload('claude.ai:conv-2')]);
    const w2 = seen.filter((s) => s.ruleId === 'W2');
    expect(w2).toHaveLength(1);
    expect(w2[0]!.sessionId).toBe('claude.ai:conv-2');
    // Sólo hashes en la base (RNF-01): el índice persiste y sobrevive a un Pipeline nuevo.
    expect(storage.getSetting<Record<string, Record<string, number[]>>>('attachmentIndex')?.['claude.ai']?.ADJ).toHaveLength(2);
  });

  it('D-11: fuera de la ventana de 7 días no cuenta', () => {
    pipe.ingest([upload('claude.ai:old')]);
    vi.advanceTimersByTime(8 * 86_400_000);
    pipe.ingest([upload('claude.ai:new')]);
    expect(seen.filter((s) => s.ruleId === 'W2')).toHaveLength(0);
  });
});
