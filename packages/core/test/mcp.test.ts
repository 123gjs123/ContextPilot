import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  decodeServers,
  isMcpServerKey,
  mcpDisableGuide,
  prettyServerName,
  R11,
  R6,
  RuleEngine,
  serverKeywords,
  serversMentioned,
  type RuleContext,
  type SessionState,
  type TurnEvent,
} from '../src/index.js';
import { ev, run } from './helpers.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const ctx = (event: TurnEvent, state: SessionState): RuleContext => ({ event, state, prev: undefined, thresholds: { ...R6.defaults }, now: NOW } as RuleContext);

describe('R6/R11: helpers MCP', () => {
  it('distingue servidor de herramienta y nombra legible', () => {
    expect(isMcpServerKey('mcp__claude_ai_Atlassian_Rovo')).toBe(true);
    expect(isMcpServerKey('mcp__jira__search')).toBe(false);
    expect(isMcpServerKey('Bash')).toBe(false);
    expect(prettyServerName('mcp__claude_ai_Atlassian_Rovo')).toBe('Atlassian Rovo');
    expect(prettyServerName('mcp__google-drive')).toBe('google drive');
  });

  it('palabras clave: nombre del servidor + alias', () => {
    const k = serverKeywords('mcp__claude_ai_Atlassian_Rovo');
    expect(k).toEqual(expect.arrayContaining(['atlassian', 'rovo', 'jira', 'confluence']));
    expect(k).not.toContain('claude');
  });

  it('detecta menciones por palabra completa, sin falsos positivos por subcadenas', () => {
    const off = ['mcp__claude_ai_Atlassian_Rovo', 'mcp__claude_ai_Gmail'];
    expect(serversMentioned('revisá el ticket SBK-12 en Jira', off)).toEqual(['mcp__claude_ai_Atlassian_Rovo']);
    expect(serversMentioned('mandame un correo con el resumen', off)).toEqual(['mcp__claude_ai_Gmail']);
    expect(serversMentioned('refactorizá jirafa.ts', off)).toEqual([]);
    expect(serversMentioned('', off)).toEqual([]);
    expect(serversMentioned('jira', [])).toEqual([]);
  });

  it('decodeServers descarta basura y duplicados', () => {
    expect(decodeServers('mcp__a, mcp__a,Bash,mcp__b__tool,,mcp__b')).toEqual(['mcp__a', 'mcp__b']);
    expect(decodeServers(undefined)).toEqual([]);
  });

  it('la guía explica cómo revertir', () => {
    const g = mcpDisableGuide(['mcp__jira'], true);
    expect(g).toContain('Desactivar en este proyecto');
    expect(g).toContain('Reactivar');
    expect(g).toContain('/mcp');
    expect(mcpDisableGuide(['mcp__jira'], false)).not.toContain('Desactivar en este proyecto');
  });
});

describe('R6: acciones ejecutables', () => {
  const tools = [{ name: 'mcp__jira', definitionTokens: 1500, estimated: true }];
  it('Claude Code: desactivar (primaria) + guía', () => {
    const at = (turn: number) => ev({ turn, toolsAvailable: tools });
    const st = run(Array.from({ length: 21 }, (_, i) => at(i + 1))).state;
    const res = R6.evaluate(ctx(at(21), st))!;
    expect(res.actions[0]).toMatchObject({ kind: 'mcp-disable', payload: 'mcp__jira' });
    expect(res.actions[1]).toMatchObject({ kind: 'show-detail', label: 'Guía paso a paso' });
  });
  it('proxy: sólo guía (no sabemos qué cliente es)', () => {
    const at = (turn: number) => ev({ source: 'proxy', turn, toolsAvailable: tools });
    const st = run(Array.from({ length: 21 }, (_, i) => at(i + 1))).state;
    const res = R6.evaluate(ctx(at(21), st))!;
    expect(res.actions.map((a) => a.kind)).toEqual(['show-detail']);
  });
});

describe('R11: recomendar reactivar', () => {
  it('sin señal no dispara; con señal ofrece reactivar', () => {
    const st = run([ev({ turn: 1 })]).state;
    expect(R11.evaluate({ ...ctx(ev({ phase: 'prompt' }), st), thresholds: {} })).toBeNull();
    const res = R11.evaluate({ ...ctx(ev({ phase: 'prompt', mcpNeeded: ['mcp__claude_ai_Atlassian_Rovo'] }), st), thresholds: {} })!;
    expect(res.title).toContain('Atlassian Rovo');
    expect(res.actions[0]).toMatchObject({ kind: 'mcp-enable', payload: 'mcp__claude_ai_Atlassian_Rovo', label: 'Reactivar Atlassian Rovo' });
  });
  it('vía motor en fase prompt', () => {
    const eng = new RuleEngine(undefined, [R11]);
    const st = applyEvent(undefined, ev({ turn: 1 }));
    const out = eng.evaluate({ event: ev({ turn: 1, phase: 'prompt', mcpNeeded: ['mcp__jira'] }), prev: st, state: st, now: NOW });
    expect(out.published[0]?.ruleId).toBe('R11');
  });
});

describe('R6 persistida con acciones viejas', () => {
  it('se reconstruye desde el detalle', async () => {
    const { upgradeLegacyR6 } = await import('../src/index.js');
    const old = { ruleId: 'R6', detail: 'Candidatas a desactivar: mcp__claude_ai_Atlassian_Rovo (≈1.2k), mcp__drive (≈900).', actions: [{ kind: 'show-detail' as const, label: 'Ver lista' }] };
    const a = upgradeLegacyR6(old, 'claude-code')!;
    expect(a[0]).toMatchObject({ kind: 'mcp-disable', payload: 'mcp__claude_ai_Atlassian_Rovo,mcp__drive' });
    expect(upgradeLegacyR6({ ...old, actions: a }, 'claude-code')).toBeUndefined();
    expect(upgradeLegacyR6({ ...old, ruleId: 'R5' }, 'claude-code')).toBeUndefined();
  });
});

describe('R6: no ofrece desactivar la integración del IDE', () => {
  it('claude-vscode queda fuera del botón', async () => {
    const { r6Actions } = await import('../src/index.js');
    const a = r6Actions(['mcp__claude_ai_Claude_Docs', 'mcp__claude-vscode'], 'claude-code');
    expect(a[0]).toMatchObject({ kind: 'mcp-disable', payload: 'mcp__claude_ai_Claude_Docs' });
    expect(r6Actions(['mcp__claude-vscode'], 'claude-code').map((x) => x.kind)).toEqual(['show-detail']);
  });
});
