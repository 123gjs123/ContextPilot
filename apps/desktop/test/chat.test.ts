import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatHost } from '../src/main/chatHost.js';
import { addUserMessage, applyCliEvent, cliArgs, encodeProjectDir, messagesFromTranscript, newChatState, permissionLine } from '../src/shared/chat.js';
import { chatName, mcpSummary, slashSuggestions, toolSummary } from '../src/shared/chatView.js';
import { parseInline, parseMarkdown } from '../src/shared/markdown.js';

const FAKE = join(__dirname, 'fixtures', 'fake-claude.mjs');
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('estado del chat (eventos del CLI)', () => {
  it('init, streaming de texto sin duplicar con el evento completo, result y uso del plan', () => {
    const s = newChatState('c', '/x');
    addUserMessage(s, 'hola');
    applyCliEvent(s, { type: 'system', subtype: 'init', session_id: 'sid', model: 'm', skills: ['a'], slash_commands: ['compact'], mcp_servers: [{ name: 'jira', status: 'connected' }] });
    applyCliEvent(s, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
    applyCliEvent(s, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } });
    applyCliEvent(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ho' } } });
    expect(s.messages.at(-1)).toMatchObject({ streaming: true, blocks: [{ kind: 'text', text: 'Ho' }] });
    applyCliEvent(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'la' } } });
    applyCliEvent(s, { type: 'stream_event', event: { type: 'message_stop' } });
    applyCliEvent(s, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hola' }] } });
    expect(s.messages.at(-1)!.blocks).toEqual([{ kind: 'text', text: 'Hola' }]);
    applyCliEvent(s, { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.3 }, seven_day: { utilization: 0.05 } } } });
    applyCliEvent(s, { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, duration_ms: 9 });
    expect(s).toMatchObject({
      sessionId: 'sid',
      model: 'm',
      skills: ['a'],
      status: 'idle',
      rateLimit: { fiveHour: 0.3, sevenDay: 0.05 },
      lastResult: { inputTokens: 10, outputTokens: 50, cacheRead: 100, cacheWrite: 5, durationMs: 9 },
    });
  });

  it('herramienta: JSON parcial → input, resultado, error; permiso pendiente y cancelado', () => {
    const s = newChatState('c', '/x');
    applyCliEvent(s, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
    applyCliEvent(s, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Bash' } } });
    applyCliEvent(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } } });
    applyCliEvent(s, { type: 'stream_event', event: { type: 'content_block_stop' } });
    expect(s.messages[0]!.blocks[0]).toMatchObject({ kind: 'tool', name: 'Bash', input: { command: 'ls' }, done: false });
    applyCliEvent(s, { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    expect(s.pending).toEqual([{ requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } }]);
    applyCliEvent(s, { type: 'control_cancel_request', request_id: 'r1' });
    expect(s.pending).toEqual([]);
    applyCliEvent(s, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x'.repeat(5000) }], is_error: true }] } });
    const t = s.messages[0]!.blocks[0] as { result: string };
    expect(t).toMatchObject({ done: true, isError: true });
    expect(t.result.length).toBeLessThan(4100);
  });

  it('ignora eventos de subagentes; la compactación agrega un aviso', () => {
    const s = newChatState('c', '/x');
    applyCliEvent(s, { type: 'assistant', parent_tool_use_id: 'x', message: { id: 'z', content: [{ type: 'text', text: 'sub' }] } });
    expect(s.messages).toEqual([]);
    applyCliEvent(s, { type: 'system', subtype: 'compact_boundary' });
    expect(s.messages[0]).toMatchObject({ role: 'system' });
  });

  it('argumentos del CLI validados y respuesta de permiso', () => {
    const sid = '11111111-2222-3333-4444-555555555555';
    expect(cliArgs({ model: 'opus', resume: sid })).toEqual(expect.arrayContaining(['--model', 'opus', '--resume', sid, '--permission-prompts', 'host']));
    expect(cliArgs({ model: 'x; rm -rf /', resume: 'nope' })).not.toContain('--model');
    expect(cliArgs({ resume: 'nope' })).not.toContain('--resume');
    expect(JSON.parse(permissionLine('r', true, { a: 1 }))).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r', response: { behavior: 'allow', updatedInput: { a: 1 } } } });
    expect(JSON.parse(permissionLine('r', false, {})).response.response.behavior).toBe('deny');
  });

  it('historial desde el transcript: sólo hilo principal, sin mensajes internos', () => {
    const lines = [
      { type: 'user', uuid: 'u1', timestamp: 't', message: { content: 'pregunta' } },
      { type: 'user', uuid: 'u0', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: 'respuesta' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }] } },
      { type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'código' }] } },
      { type: 'assistant', uuid: 'a2', isSidechain: true, message: { id: 'm2', content: [{ type: 'text', text: 'subagente' }] } },
    ]
      .map((x) => JSON.stringify(x))
      .concat(['no es json']);
    const ms = messagesFromTranscript(lines);
    expect(ms.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(ms[1]!.blocks[1]).toMatchObject({ kind: 'tool', name: 'Read', result: 'código', done: true });
    expect(encodeProjectDir('C:\\Users\\a b')).toBe('C--Users-a-b');
  });
});

describe('markdown', () => {
  it('bloques y en línea, sin interpretar HTML ni links peligrosos', () => {
    const b = parseMarkdown('# Título\n\nTexto con `código` y **negrita** y [link](https://x.y).\n\n```ts\nconst a = 1;\n```\n- uno\n- dos\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>');
    expect(b.map((x) => x.t)).toEqual(['heading', 'p', 'code', 'list', 'table', 'p']);
    expect(b[2]).toMatchObject({ lang: 'ts', v: 'const a = 1;' });
    expect(b[5]).toEqual({ t: 'p', c: [{ t: 'text', v: '<script>alert(1)</script>' }] });
    expect(parseInline('a [x](javascript:alert(1)) b')).toEqual([{ t: 'text', v: 'a [x](javascript:alert(1)) b' }]);
    expect(parseInline('2*3*4 no es cursiva')).toEqual([{ t: 'text', v: '2*3*4 no es cursiva' }]);
  });
});

describe('vista del chat', () => {
  it('resumen de herramientas, autocompletado de / y nombres', () => {
    expect(toolSummary('Bash', { command: 'npm   test' })).toBe('Bash · npm test');
    expect(toolSummary('mcp__claude_ai_Atlassian__searchJira', { query: 'SBF' })).toBe('Atlassian › searchJira · SBF');
    const s = { skills: ['qatc-sbf-migration', 'review'], slashCommands: ['compact', 'review', 'clear'] };
    expect(slashSuggestions(s, '/re').map((x) => `${x.kind}:${x.value}`)).toEqual(['skill:review']);
    expect(slashSuggestions(s, '/c').map((x) => x.value)).toEqual(['compact', 'clear', 'qatc-sbf-migration']);
    expect(slashSuggestions(s, 'hola')).toEqual([]);
    expect(chatName({ cwd: 'C:\\repos\\api', sessionId: 's', createdAt: '' }, { s: 'api — Migración' })).toBe('api — Migración');
    expect(chatName({ cwd: 'C:\\repos\\api', createdAt: '' }, {})).toBe('api — chat nuevo');
    expect(mcpSummary({ mcp: [{ name: 'a', status: 'connected' }, { name: 'claude_ai_Gmail', status: 'needs-auth' }] })).toBe('MCP 1/2 · sin conectar: Gmail');
  });
});

describe('ChatHost con un CLI falso', () => {
  const until = async (fn: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const make = (home: string, extra: Partial<ConstructorParameters<typeof ChatHost>[0]> = {}) =>
    new ChatHost({ home, claudeBin: process.execPath, prefixArgs: [FAKE], onUpdate: () => {}, onList: () => {}, ...extra });

  it('conversa, guarda sólo metadatos, pide permiso y lo respeta, cambia de modelo con --resume', async () => {
    const home = tmp('cp-chat-');
    const h = make(home);
    const c = h.create(tmp('cp-chat-cwd-'));
    expect(h.send(c.id, 'hola').ok).toBe(true);
    await until(() => h.open(c.id)!.status === 'idle' && !!h.open(c.id)!.lastResult);
    const s = h.open(c.id)!;
    expect(s.sessionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[1]!.blocks).toEqual([{ kind: 'text', text: 'Hola, soy **Claude**.' }]);
    expect(s.skills).toContain('qatc-sbf-migration');
    // chats.json: metadatos sin el texto de la conversación.
    const stored = readFileSync(join(home, 'chats.json'), 'utf8');
    expect(stored).toContain('11111111-2222-3333-4444-555555555555');
    expect(stored).not.toContain('Hola');
    expect(h.bySession('11111111-2222-3333-4444-555555555555')?.id).toBe(c.id);

    h.send(c.id, 'usá bash');
    await until(() => h.open(c.id)!.pending.length === 1);
    expect(h.permission(c.id, 'req-1', false).ok).toBe(true);
    await until(() => h.open(c.id)!.status === 'idle');
    expect(h.open(c.id)!.messages.at(-1)!.blocks[0]).toMatchObject({ kind: 'tool', name: 'Bash', input: { command: 'echo hola' }, isError: true, done: true });

    expect(h.setModel(c.id, 'haiku').ok).toBe(true);
    h.send(c.id, 'otra');
    await until(() => h.open(c.id)!.model === 'haiku' && h.open(c.id)!.status === 'idle' && h.open(c.id)!.messages.length >= 6);
    await h.closeAll();
  }, 20000);

  it('CLI ausente o carpeta inexistente: error claro', () => {
    const home = tmp('cp-chat-');
    const none = make(home, { claudeBin: null });
    expect(none.send(none.create(home).id, 'x')).toMatchObject({ ok: false, message: expect.stringContaining('CLI') });
    const h2 = make(home);
    expect(h2.send(h2.create(join(home, 'no-existe')).id, 'x')).toMatchObject({ ok: false, message: expect.stringContaining('no existe') });
  });

  it('al reabrir reconstruye el historial desde el transcript de Claude Code', () => {
    const home = tmp('cp-chat-');
    const claudeHome = tmp('cp-claude-');
    const cwd = 'C:\\proyecto\\x';
    const sid = '11111111-2222-3333-4444-555555555555';
    mkdirSync(join(claudeHome, 'projects', encodeProjectDir(cwd)), { recursive: true });
    writeFileSync(join(claudeHome, 'projects', encodeProjectDir(cwd), `${sid}.jsonl`), JSON.stringify({ type: 'user', uuid: 'u', message: { content: 'pregunta vieja' } }));
    writeFileSync(join(home, 'chats.json'), JSON.stringify({ chats: [{ id: 'c1', cwd, sessionId: sid, createdAt: 'a', updatedAt: 'b' }] }));
    const h = make(home, { env: { CLAUDE_CONFIG_DIR: claudeHome }, claudeBin: null });
    expect(h.open('c1')!.messages[0]!.blocks[0]).toEqual({ kind: 'text', text: 'pregunta vieja' });
  });
});
