import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpToggles, settingsLocalPath } from '../src/mcpToggle.js';
import { ev, rmrf, startTestDaemon, tempDir, waitFor, type TestDaemon } from './helpers.js';

// R6/R11: desactivar/reactivar MCP por proyecto. Siempre sobre carpetas temporales.

const dirs: string[] = [];
const daemons: TestDaemon[] = [];
afterEach(async () => {
  for (const t of daemons.splice(0)) await t.close();
  for (const d of dirs.splice(0)) rmrf(d);
});
function tmp(): string {
  const d = tempDir('cp-mcp-');
  dirs.push(d);
  return d;
}
const read = (cwd: string) => JSON.parse(readFileSync(settingsLocalPath(cwd), 'utf8'));

describe('McpToggles', () => {
  it('desactiva creando settings.local.json y revierte dejando el archivo limpio', () => {
    const cwd = tmp();
    const t = new McpToggles(join(tmp(), 'mcp-toggles.json'));
    const r = t.disable(cwd, ['mcp__jira', 'mcp__jira', 'Bash']);
    expect(r).toMatchObject({ ok: true, servers: ['mcp__jira'] });
    expect(read(cwd).permissions.deny).toEqual(['mcp__jira']);
    expect(t.list(cwd)).toEqual(['mcp__jira']);
    expect(t.enable(cwd, ['mcp__jira'])).toMatchObject({ ok: true, servers: ['mcp__jira'] });
    expect(read(cwd)).toEqual({});
    expect(t.list(cwd)).toEqual([]);
  });

  it('preserva el resto del archivo y nunca quita reglas del usuario', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(settingsLocalPath(cwd), JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'], deny: ['mcp__slack'] } }));
    const t = new McpToggles(join(tmp(), 'rec.json'));
    // mcp__slack ya lo bloqueaba el usuario: no se registra como propio.
    expect(t.disable(cwd, ['mcp__slack', 'mcp__jira'])).toMatchObject({ ok: true, servers: ['mcp__jira'] });
    expect(t.enable(cwd, ['mcp__slack', 'mcp__jira'])).toMatchObject({ ok: true, servers: ['mcp__jira'] });
    expect(read(cwd)).toEqual({ model: 'x', permissions: { allow: ['Bash(ls)'], deny: ['mcp__slack'] } });
  });

  it('JSON inválido: no toca el archivo', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(settingsLocalPath(cwd), '{ roto');
    const t = new McpToggles(join(tmp(), 'rec.json'));
    const r = t.disable(cwd, ['mcp__jira']);
    expect(r.ok).toBe(false);
    expect(readFileSync(settingsLocalPath(cwd), 'utf8')).toBe('{ roto');
  });

  it('cwd desconocido o relativo: error sin escribir', () => {
    const t = new McpToggles(join(tmp(), 'rec.json'));
    expect(t.disable('relativo', ['mcp__jira']).ok).toBe(false);
    expect(t.disable(join(tmp(), 'no-existe'), ['mcp__jira']).ok).toBe(false);
  });

  it('el registro sobrevive a un reinicio', () => {
    const cwd = tmp();
    const rec = join(tmp(), 'rec.json');
    new McpToggles(rec).disable(cwd, ['mcp__jira']);
    expect(new McpToggles(rec).list(cwd)).toEqual(['mcp__jira']);
  });
});

describe('daemon: rutas /mcp y R11 desde el hook', () => {
  it('desactiva vía API, la vista trae mcpDisabled y un prompt que menciona Jira dispara R11', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const cwd = tmp();
    t.d.pipeline.ingest([ev({ sessionId: 'S1', turn: 1 })]);
    // Sin cwd todavía: 409 con explicación.
    let r = await t.api('/mcp/disable', { method: 'POST', json: { sessionId: 'S1', servers: ['mcp__claude_ai_Atlassian_Rovo'] } });
    expect(r.status).toBe(409);
    await t.api('/ingest/hooks/Stop', { method: 'POST', json: { session_id: 'S1', cwd } });
    r = await t.api('/mcp/disable', { method: 'POST', json: { sessionId: 'S1', servers: ['mcp__claude_ai_Atlassian_Rovo'] } });
    expect(r.status).toBe(200);
    expect(existsSync(settingsLocalPath(cwd))).toBe(true);
    const views = (await (await t.api('/sessions')).json()) as { sessionId: string; mcpDisabled?: string[] }[];
    expect(views.find((v) => v.sessionId === 'S1')?.mcpDisabled).toEqual(['mcp__claude_ai_Atlassian_Rovo']);

    await t.api('/ingest/hooks/UserPromptSubmit', { method: 'POST', json: { session_id: 'S1', cwd, prompt: 'traeme el ticket de Jira SBK-1' } });
    const sug = await waitFor(() => t.d.pipeline.visibleFor('S1'));
    expect(sug.ruleId).toBe('R11');
    expect(sug.actions[0]).toMatchObject({ kind: 'mcp-enable', payload: 'mcp__claude_ai_Atlassian_Rovo' });

    r = await t.api('/mcp/enable', { method: 'POST', json: { sessionId: 'S1', servers: ['mcp__claude_ai_Atlassian_Rovo'] } });
    expect(r.status).toBe(200);
    expect((await (await t.api('/mcp/disabled?sessionId=S1')).json()).servers).toEqual([]);
  });

  it('valida el cuerpo', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    expect((await t.api('/mcp/disable', { method: 'POST', json: { servers: [] } })).status).toBe(400);
    expect((await t.api('/mcp/disable', { method: 'POST', json: { sessionId: 'S1', servers: 'x' } })).status).toBe(400);
  });
});
