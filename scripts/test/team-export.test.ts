import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregateTeam } from '../../packages/core/src/index.ts';
import * as lib from '../lib/team-export.ts';
// @ts-ignore — módulo JS
import { run } from '../team-export.mjs';

// CP-057.1 / D-12. cp.db sintética con el esquema del daemon (tablas sessions y suggestions).
const NOW = Date.parse('2026-10-01T12:00:00Z');
const uuid = (i: number) => `5973b6c0-94b8-487b-a530-${String(i).padStart(12, '0')}`;
let dir: string;
let db: string;
const quiet = { log: () => {}, err: () => {}, now: NOW };

function session(i: number, provider: string, startedAt: string) {
  return {
    sessionId: uuid(i),
    source: 'claude-code',
    provider,
    client: 'cli',
    model: 'claude-opus-5-5',
    startedAt,
    lastTurnAt: startedAt,
    totals: { input: 100, output: 10, cacheRead: 1000, cacheWrite: 50, reasoning: 0 },
    cwd: 'C:\\Users\\jdoe\\proyecto-secreto',
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cp-team-'));
  db = join(dir, 'cp.db');
  const SQL = await initSqlJs();
  const d = new SQL.Database();
  d.run(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, source TEXT, provider TEXT, client TEXT, model TEXT,
    started_at TEXT, last_turn_at TEXT, last_turn_ms INTEGER, state_json TEXT NOT NULL);
    CREATE TABLE suggestions (id TEXT PRIMARY KEY, session_id TEXT, rule_id TEXT, severity TEXT, created_ms INTEGER, expires_ms INTEGER,
    estimated_saving INTEGER, quiet INTEGER, json TEXT, status TEXT DEFAULT 'open', feedback TEXT, feedback_ms INTEGER, surface TEXT);`);
  const add = (i: number, provider: string, ts: string) => {
    const s = session(i, provider, ts);
    d.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)', [s.sessionId, s.source, provider, s.client, s.model, ts, ts, Date.parse(ts), JSON.stringify(s)]);
    const sg = { id: `sg${i}`, sessionId: s.sessionId, ruleId: 'R1', createdAt: ts, estimatedSavingTokens: 1000 };
    d.run('INSERT INTO suggestions (id, session_id, rule_id, created_ms, json, status, feedback) VALUES (?,?,?,?,?,?,?)', [
      sg.id, s.sessionId, 'R1', Date.parse(ts), JSON.stringify(sg), 'closed', i < 3 ? 'accepted' : 'dismissed',
    ]);
  };
  for (let i = 0; i < 6; i++) add(i, 'anthropic', '2026-09-29T10:00:00Z'); // semana 40, visible
  for (let i = 10; i < 12; i++) add(i, 'openai', '2026-09-30T10:00:00Z'); // < 5 sesiones → suprimido
  add(20, 'anthropic', '2026-09-20T10:00:00Z'); // semana 38, fuera de rango
  writeFileSync(db, d.export());
  d.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('weekRange', () => {
  it('lunes a lunes UTC de la semana ISO', () => {
    const r = lib.weekRange('2026-W40');
    expect(new Date(r.from).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(new Date(r.to).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(lib.weekRange('2027-W01').from).toBe(Date.parse('2027-01-04T00:00:00Z'));
    expect(lib.weekRange(undefined, NOW).week).toBe('2026-W40');
    expect(() => lib.weekRange('2026-40')).toThrow(/inválida/);
    expect(() => lib.weekRange('2026-W54')).toThrow(/inexistente/);
  });
});

describe('teamLeakCheck', () => {
  const ok = aggregateTeam({ sessions: [], suggestions: [], now: NOW });
  it('acepta un export limpio', () => expect(lib.teamLeakCheck(ok)).toEqual({ ok: true, problems: [] }));
  it('detecta ids, hashes, rutas, claves extra y buckets chicos', () => {
    const bad = {
      ...ok,
      extra: 'C:\\Users\\jdoe',
      byRule: [{ week: '2026-W40', ruleId: 'R1', sessions: 2, fired: 1, accepted: 0, dismissed: 0, snoozed: 0, acceptanceRate: 0, savedTokens: 0, sessionId: uuid(1) }],
      h: 'deadbeefdeadbeef00',
    };
    const r = lib.teamLeakCheck(bad, ['proyecto-secreto']);
    expect(r.ok).toBe(false);
    expect(r.problems.join('|')).toMatch(/hex/);
    expect(r.problems.join('|')).toMatch(/UUID/);
    expect(r.problems.join('|')).toMatch(/ruta/);
    expect(r.problems.join('|')).toMatch(/campo identificador/);
    expect(r.problems.join('|')).toMatch(/clave no permitida \$\.extra/);
    expect(r.problems.join('|')).toMatch(/bucket con 2 < 5/);
    expect(lib.teamLeakCheck({ ...ok, x: 'proyecto-secreto' }, ['proyecto-secreto']).problems.join()).toMatch(/valor prohibido/);
  });
});

describe('team-export --offline (sql.js + aggregateTeam)', () => {
  it('exporta la semana con buckets ≥ 5 sesiones y sin identificadores', async () => {
    const out = join(dir, 'team.json');
    const r = await run(['--week', '2026-W40', '--db', db, '--out', out], lib, quiet);
    expect(r.code).toBe(0);
    const exp = JSON.parse(readFileSync(out, 'utf8'));
    expect(exp.byProvider).toEqual([
      { week: '2026-W40', provider: 'anthropic', sessions: 6, input: 600, output: 60, cacheRead: 6000, cacheWrite: 300, suggestions: 6, accepted: 3, dismissed: 3, snoozed: 0, savedTokens: 3000 },
    ]);
    // Las reglas se agregan por (semana, regla) sin distinguir proveedor: 6 anthropic + 2 openai.
    expect(exp.byRule).toEqual([{ week: '2026-W40', ruleId: 'R1', sessions: 8, fired: 8, accepted: 3, dismissed: 5, snoozed: 0, acceptanceRate: 0.375, savedTokens: 3000 }]);
    expect(exp.suppressedBuckets).toBe(1); // bucket (W40, openai) con 2 sesiones
    const text = readFileSync(out, 'utf8');
    expect(text).not.toMatch(/5973b6c0|jdoe|proyecto|claude-opus|sessionId/);
  });

  it('sin --out imprime a stdout; semana sin datos → export vacío', async () => {
    const lines: string[] = [];
    const r = await run(['--week', '2026-W30', '--offline', '--db', db], lib, { ...quiet, log: (l: string) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ byProvider: [], byRule: [], weeks: [] });
  });

  it('cp.db inexistente → error claro', async () => {
    await expect(run(['--week', '--db', join(dir, 'no.db')], lib, quiet)).rejects.toThrow(/no existe/);
  });
});

describe('team-export online (GET /team/export)', () => {
  let server: Server;
  let body: unknown;
  let seen: { token?: string; url?: string } = {};
  const env = () => ({ CONTEXTPILOT_HOME: dir, CONTEXTPILOT_PORT: String((server.address() as AddressInfo).port) });

  beforeAll(async () => {
    writeFileSync(join(dir, 'token'), 'tok123\n');
    server = createServer((req, res) => {
      seen = { token: req.headers['x-cp-token'] as string, url: req.url };
      if (req.headers['x-cp-token'] !== 'tok123') {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('usa el token del directorio de datos y el rango de la semana', async () => {
    body = aggregateTeam({ sessions: [], suggestions: [], now: NOW });
    const out = join(dir, 'online.json');
    const r = await run(['--week', '2026-W40', '--out', out], lib, { ...quiet, env: env() });
    expect(r.code).toBe(0);
    expect(seen.token).toBe('tok123');
    expect(decodeURIComponent(seen.url!)).toBe('/team/export?from=2026-09-28T00:00:00.000Z&to=2026-10-05T00:00:00.000Z');
    expect(JSON.parse(readFileSync(out, 'utf8')).schema).toBe('contextpilot.team/1');
  });

  it('si el daemon devuelve algo con ids, no escribe y sale 1', async () => {
    body = { ...aggregateTeam({ sessions: [], suggestions: [], now: NOW }), sessionId: uuid(1) };
    const out = join(dir, 'leak.json');
    const r = await run(['--week', '2026-W40', '--out', out], lib, { ...quiet, env: env() });
    expect(r.code).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('daemon caído → sugiere --offline', async () => {
    await expect(lib.fetchOnline(0, 1, { CONTEXTPILOT_HOME: dir, CONTEXTPILOT_PORT: '1' }, 500)).rejects.toThrow(/--offline/);
  });
});
