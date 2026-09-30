import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { RuleEngine } from '@contextpilot/core';
import { defaultDaemonConfig } from '../src/config.js';
import { HealthRegistry } from '../src/health.js';
import { nullLogger } from '../src/log.js';
import { Pipeline } from '../src/pipeline.js';
import { SCHEMA_VERSION, Storage } from '../src/storage.js';
import { ev, tempDir, rmrf } from './helpers.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

// CP-061 (título sólo en memoria, proyecto persistido) y CP-065 (marca de subagente en el timeline).

async function pipe(metaFor?: (sid: string) => { project?: string; title?: string } | undefined) {
  const storage = await Storage.open(null);
  const cfg = defaultDaemonConfig();
  const p = new Pipeline(storage, new RuleEngine(cfg), new HealthRegistry(), () => cfg, nullLogger, { metaFor });
  return { storage, p };
}

describe('nombres de sesión en el daemon (CP-061)', () => {
  it('el título llega a la vista pero nunca a cp.db; el proyecto sí se guarda', async () => {
    const { storage, p } = await pipe();
    const views: string[] = [];
    p.on('session', (v) => views.push(v.displayName ?? ''));
    p.ingest([ev({ sessionId: 'claude.ai:c1', source: 'web', client: 'claude.ai', title: 'Plan de pruebas ultra secreto', tokens: { input: 10, output: 10, estimated: true } })]);
    p.ingest([ev({ sessionId: 'S2', project: 'contextpilot' })]);
    expect(views).toEqual(['claude.ai — Plan de pruebas ultra secreto', 'contextpilot']);
    expect(p.activeViews().find((v) => v.sessionId === 'claude.ai:c1')?.title).toBe('Plan de pruebas ultra secreto');
    storage.flush();
    const bytes = Buffer.from(storage.exportBytes()).toString('latin1');
    expect(bytes).not.toContain('ultra secreto');
    expect(bytes).toContain('contextpilot');
    p.dispose();
  });
  it('metaFor (parser en memoria) da el título tras un reinicio', async () => {
    const { p } = await pipe((sid) => (sid === 'S1' ? { project: 'automation-api-sportsbook', title: 'Tests de parlays' } : undefined));
    p.ingest([ev({ sessionId: 'S1' })]);
    expect(p.activeViews()[0]).toMatchObject({ project: 'automation-api-sportsbook', displayName: 'automation-api-sportsbook — Tests de parlays' });
    p.dispose();
  });
});

describe('timeline con marca de subagente (CP-065)', () => {
  it('guarda sidechain y lo devuelve; migra una base v1 (filas previas = null)', async () => {
    const dir = tempDir();
    try {
      // Base v1: tabla turns sin la columna.
      const SQL = await initSqlJs();
      const db = new SQL.Database();
      db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version','1');
        CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL, ts_ms INTEGER NOT NULL, turn INTEGER,
        phase TEXT, source TEXT, provider TEXT, client TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
        reasoning INTEGER, context_size INTEGER, context_window INTEGER, idle_ms INTEGER, estimated INTEGER, cache_ratio REAL, prompt_hash TEXT);
        INSERT INTO turns VALUES ('old','S1','2026-09-30T09:00:00.000Z',${Date.parse('2026-09-30T09:00:00Z')},1,'response','claude-code','anthropic','cli','m',1,1,0,0,0,90000,200000,0,0,NULL,'');`);
      const file = join(dir, 'cp.db');
      writeFileSync(file, db.export());
      const s = await Storage.open(file);
      expect(s.schemaVersion()).toBe(SCHEMA_VERSION);
      s.insertTurn(ev({ id: 'main', sessionId: 'S1', ts: '2026-09-30T10:00:00.000Z', contextSize: 100_000 }), 0.9);
      s.insertTurn(ev({ id: 'side', sessionId: 'S1', ts: '2026-09-30T10:00:05.000Z', contextSize: 5000, sidechain: true }), 0.5);
      expect(s.timeline('S1').map((p) => [p.contextSize, p.sidechain])).toEqual([[90_000, null], [100_000, false], [5000, true]]);
      s.close();
    } finally {
      rmrf(dir);
    }
  });
});
