import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEvent } from '@contextpilot/core';
import { SCHEMA_VERSION, Storage } from '../src/storage.js';
import { ev, rmrf, startTestDaemon, tempDir } from './helpers.js';

// CP-023: sql.js con esquema versionado, volcado atómico con debounce, retención; RNF-01 fuga.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

describe('Storage', () => {
  it('crea el esquema con versión y hace roundtrip a disco', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const file = join(dir, 'cp.db');
    const s = await Storage.open(file);
    expect(s.schemaVersion()).toBe(SCHEMA_VERSION);
    const e = ev({ sessionId: 'RT', toolCalls: [{ name: 'Bash', resultTokens: 12, failed: true, argsHash: 'h1' }], promptEmbedding: [0.1, 0.2] });
    expect(s.insertTurn(e, 0.5)).toBe(true);
    expect(s.insertTurn(e, 0.5)).toBe(false);
    s.saveSession(applyEvent(undefined, e));
    s.insertSuggestion({
      id: 'SG1', ruleId: 'R1', sessionId: 'RT', severity: 'info', title: 't', detail: 'd',
      actions: [{ kind: 'copy', label: 'x', payload: '/compact' }], expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(),
    });
    s.setFeedback('SG1', 'accepted', 'tray');
    s.setOffset('C:/x.jsonl', 123);
    s.setTranscript('RT', 'C:/x.jsonl', 'claude-code');
    s.close();
    expect(existsSync(file)).toBe(true);

    const r = await Storage.open(file);
    expect(r.hasTurn(e.id)).toBe(true);
    expect(r.loadSession('RT')?.calls).toBe(1);
    expect(r.getSuggestion('SG1')?.feedback).toBe('accepted');
    expect(r.getOffset('C:/x.jsonl')).toBe(123);
    expect(r.getTranscript('RT')?.path).toBe('C:/x.jsonl');
    expect(r.timeline('RT')).toHaveLength(1);
    r.close();
  });

  it('volcado con debounce ≤ 5 s y sin archivos temporales colgando', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const file = join(dir, 'cp.db');
    const s = await Storage.open(file);
    s.insertTurn(ev(), null);
    expect(existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 1800));
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    s.close();
  });

  it('archivo corrupto (kill a mitad de una escritura no atómica) → se aparta y arranca limpio', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const file = join(dir, 'cp.db');
    writeFileSync(file, Buffer.from('SQLite format 3\u0000 basura truncada'));
    const s = await Storage.open(file);
    expect(s.schemaVersion()).toBe(SCHEMA_VERSION);
    s.close();
    expect(readdirSync(dir).some((f) => f.startsWith('cp.db.corrupt-'))).toBe(true);
  });

  it('un temporal huérfano (corte antes del rename) no afecta la base vigente', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const file = join(dir, 'cp.db');
    const s = await Storage.open(file);
    s.insertTurn(ev({ id: 'KEEP' }), null);
    s.close();
    writeFileSync(`${file}.999.tmp`, 'a medio escribir');
    const r = await Storage.open(file);
    expect(r.hasTurn('KEEP')).toBe(true);
    r.close();
  });

  it('retención: purga turnos, sugerencias y sesiones más viejas que N días', async () => {
    const s = await Storage.open(null);
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const oldEv = ev({ id: 'OLD', sessionId: 'OLDS', ts: old });
    s.insertTurn(oldEv, null);
    s.saveSession(applyEvent(undefined, oldEv));
    s.insertTurn(ev({ id: 'NEW', sessionId: 'NEWS' }), null);
    expect(s.purge(30)).toBe(1);
    expect(s.hasTurn('OLD')).toBe(false);
    expect(s.hasTurn('NEW')).toBe(true);
    expect(s.loadSession('OLDS')).toBeUndefined();
    s.close();
  });
});

describe('retención al arrancar el daemon', () => {
  it('turnos de hace 40 días se purgan al arrancar', async () => {
    const home = tempDir();
    dirs.push(home);
    const s = await Storage.open(join(home, 'cp.db'));
    s.insertTurn(ev({ id: 'ANCIENT', ts: new Date(Date.now() - 40 * 86_400_000).toISOString() }), null);
    s.insertTurn(ev({ id: 'FRESH' }), null);
    s.close();
    const t = await startTestDaemon({ home });
    expect(t.d.storage.hasTurn('ANCIENT')).toBe(false);
    expect(t.d.storage.hasTurn('FRESH')).toBe(true);
    await t.close();
  });
});

describe('privacidad (RNF-01, CP-006.3, CP-032.4)', () => {
  it('sin opt-in, ni el contenido ni el prompt del hook llegan a cp.db', async () => {
    const t = await startTestDaemon();
    const SECRET = 'contenido-privado-que-no-debe-persistir-9f8e7d';
    await t.api('/ingest/events', { method: 'POST', json: [{ ...ev({ sessionId: 'LEAK', source: 'web', client: 'claude.ai' }), content: SECRET }] });
    await t.api('/ingest/hooks/UserPromptSubmit', {
      method: 'POST',
      json: { session_id: 'LEAK', transcript_path: join(t.dirs.claude, 'p', 'LEAK.jsonl'), hook_event_name: 'UserPromptSubmit', prompt: SECRET },
    });
    t.d.storage.flush();
    const bytes = readFileSync(join(t.home, 'cp.db'));
    expect(bytes.includes(SECRET)).toBe(false);

    // con opt-in de la fuente, se guarda redactado
    await t.api('/config', { method: 'PUT', json: { storeContent: { web: true } } });
    await t.api('/ingest/events', {
      method: 'POST',
      json: [{ ...ev({ sessionId: 'LEAK2', source: 'web', client: 'claude.ai' }), content: `${SECRET} sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123` }],
    });
    t.d.storage.flush();
    const after = readFileSync(join(t.home, 'cp.db'));
    expect(after.includes(SECRET)).toBe(true);
    expect(after.includes('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123')).toBe(false);
    await t.close();
  });
});
