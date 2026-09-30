import { describe, expect, it } from 'vitest';
import { ClaudeCodeParser, mcpServerKey } from '../../src/index.js';

// D-4 (R6 en Claude Code) y D-2 (foco de /compact) sobre líneas sintéticas con la forma real del transcript.

const SID = 'sess-1';
let n = 0;
const ts = () => new Date(Date.parse('2026-09-29T10:00:00Z') + n++ * 1000).toISOString();
const line = (o: object) => JSON.stringify({ sessionId: SID, timestamp: ts(), ...o });
const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } });
const toolUse = (id: string, name: string, input: object) =>
  line({ type: 'assistant', message: { id, model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'tool_use', id: `tu-${id}`, name, input }], usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 1000 } } });
const result = (id: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: 'ok' }] } });
const attachment = (a: object) => line({ type: 'attachment', attachment: a });

describe('inventario MCP desde adjuntos (D-4)', () => {
  it('agrupa por servidor, suma nombres diferidos + instrucciones + definiciones cargadas; marca estimado', () => {
    const p = new ClaudeCodeParser();
    p.feed(
      attachment({
        type: 'deferred_tools_delta',
        addedNames: ['Monitor', 'mcp__jira__search', 'mcp__jira__create_issue', 'mcp__drive__get'],
        addedLines: ['Monitor', 'mcp__jira__search', 'mcp__jira__create_issue', 'mcp__drive__get'],
        removedNames: [],
      }),
    );
    p.feed(attachment({ type: 'mcp_instructions_delta', addedNames: ['claude.ai Docs'], addedBlocks: ['x'.repeat(4000)], removedNames: [] }));
    p.feed(attachment({ type: 'deferred_tools_record', entries: [{ name: 'mcp__jira__search', description: 'd'.repeat(2000), input_schema: {} }] }));
    p.feed(prompt('hola'));
    const [e] = p.feed(toolUse('m1', 'Read', { file_path: 'C:\\repo\\src\\a.ts' }));
    const inv = e!.toolsAvailable!;
    expect(inv.map((t) => t.name).sort()).toEqual(['mcp__claude_ai_Docs', 'mcp__drive', 'mcp__jira']);
    expect(inv.every((t) => t.estimated)).toBe(true);
    const jira = inv.find((t) => t.name === 'mcp__jira')!.definitionTokens;
    const drive = inv.find((t) => t.name === 'mcp__drive')!.definitionTokens;
    expect(jira).toBeGreaterThan(drive + 300); // incluye la definición cargada
    expect(inv.find((t) => t.name === 'mcp__claude_ai_Docs')!.definitionTokens).toBeGreaterThan(500);
    // Herramientas nativas (Monitor) no se listan: no se desactivan por servidor.
    expect(inv.some((t) => t.name === 'Monitor')).toBe(false);
  });
  it('removedNames quita del inventario', () => {
    const p = new ClaudeCodeParser();
    p.feed(attachment({ type: 'deferred_tools_delta', addedNames: ['mcp__jira__search'], addedLines: ['mcp__jira__search'], removedNames: [] }));
    p.feed(attachment({ type: 'deferred_tools_delta', addedNames: [], addedLines: [], removedNames: ['mcp__jira__search'] }));
    expect(p.toolsAvailable()).toEqual([]);
  });
  it('mcpServerKey normaliza nombres visibles y de herramienta', () => {
    expect(mcpServerKey('claude.ai Atlassian Rovo')).toBe('claude_ai_Atlassian_Rovo');
    expect(mcpServerKey('mcp__claude_ai_Atlassian_Rovo__search')).toBe('claude_ai_Atlassian_Rovo');
  });
});

describe('foco de /compact (D-2, CP-010.3)', () => {
  it('archivos (nombre base) y herramientas más usados de los últimos 5 prompts, sin texto de prompt', () => {
    const p = new ClaudeCodeParser();
    // Prompt viejo (queda fuera de los últimos 5).
    p.feed(prompt('secreto del prompt viejo'));
    p.feed(toolUse('old', 'Edit', { file_path: '/repo/viejo.ts' }));
    for (let i = 0; i < 5; i++) {
      p.feed(prompt(`texto privado del prompt ${i}`));
      p.feed(toolUse(`a${i}`, 'Edit', { file_path: 'C:\\repo\\src\\engine.ts' }));
      p.feed(result(`a${i}`));
      p.feed(toolUse(`b${i}`, 'Bash', { command: 'npm test' }));
      p.feed(result(`b${i}`));
      if (i % 2) p.feed(toolUse(`c${i}`, 'Read', { file_path: '/repo/src/state.ts' }));
    }
    const f = p.focus()!;
    expect(f).toContain('engine.ts');
    expect(f).toContain('state.ts');
    expect(f).toContain('Edit');
    expect(f).toContain('Bash');
    expect(f).not.toContain('viejo.ts');
    expect(f).not.toContain('privado');
    expect(f).not.toContain('C:\\repo');
    expect(f.length).toBeLessThanOrEqual(180);
  });
  it('sin actividad → undefined', () => {
    expect(new ClaudeCodeParser().focus()).toBeUndefined();
  });
});
