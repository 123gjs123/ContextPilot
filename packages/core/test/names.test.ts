import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  ClaudeCodeParser,
  cleanTitle,
  CodexParser,
  contentWordCount,
  embed,
  estimateTokens,
  projectFromCwd,
  R4,
  redact,
  sessionDisplayName,
  sessionNameOf,
  shortSessionId,
  toView,
  validateTurnEvent,
  type SessionState,
  type TurnEvent,
} from '../src/index.js';
import { ev, fixture } from './helpers.js';

// CP-061 (nombres de sesión) y CP-064 (R4 robusto).

describe('nombres de sesión (CP-061)', () => {
  it('projectFromCwd: nombre base con / o \\, sin unidad sola', () => {
    expect(projectFromCwd('C:\\Users\\fosh\\contextpilot')).toBe('contextpilot');
    expect(projectFromCwd('/home/x/automation-api-sportsbook/')).toBe('automation-api-sportsbook');
    expect(projectFromCwd('C:\\')).toBeUndefined();
    expect(projectFromCwd(42)).toBeUndefined();
  });
  it('cleanTitle: una línea, redacta secretos, corta a 80', () => {
    expect(cleanTitle('  Plan\n de pruebas ')).toBe('Plan de pruebas');
    expect(cleanTitle('clave sk-ant-abcdefghijklmnopqrstuvwxyz')).toContain('[REDACTED:anthropic-key]');
    expect(cleanTitle('x'.repeat(200))!.length).toBe(80);
    expect(cleanTitle('   ')).toBeUndefined();
  });
  it('displayName: «proyecto — título»; web usa el sitio; sin datos, el cliente', () => {
    const b = { sessionId: 'abc12345-6789', source: 'claude-code' as const, client: 'cli' };
    expect(sessionDisplayName({ ...b, project: 'contextpilot', title: 'Monitor' })).toBe('contextpilot — Monitor');
    expect(sessionDisplayName({ ...b, project: 'contextpilot' })).toBe('contextpilot');
    expect(sessionDisplayName({ ...b, title: 'Monitor' })).toBe('Monitor');
    expect(sessionDisplayName(b)).toBe('cli');
    expect(sessionDisplayName({ sessionId: 'claude.ai:xyz', source: 'web', client: 'claude.ai', title: 'Plan' })).toBe('claude.ai — Plan');
    expect(shortSessionId('claude.ai:0123456789')).toBe('01234567');
    expect(sessionNameOf({ ...b, displayName: 'X' })).toEqual({ name: 'X', shortId: 'abc12345' });
  });
  it('Claude Code: project = cwd del registro, title = último ai-title (fixture)', () => {
    const p = new ClaudeCodeParser({ embedPrompts: false });
    const events = fixture('claude-code/session-main.jsonl').split('\n').flatMap((l) => p.feed(l));
    expect(p.meta().project).toBe('xxxxxxxxxxxxxx');
    expect(p.meta().title).toMatch(/^x+ x+/);
    const last = events.at(-1)!;
    expect(last.project).toBe('xxxxxxxxxxxxxx');
    expect(last.title).toBe(p.meta().title);
    // Subagentes: el proyecto (mismo cwd) sí, el título no.
    const sub = new ClaudeCodeParser({ sidechain: true, parentSessionId: 'P' });
    const subEvents = fixture('claude-code/session-subagent.jsonl').split('\n').flatMap((l) => sub.feed(l));
    expect(sub.meta()).toEqual({ project: 'xxxxxxxxxxxxxx', title: undefined });
    expect(applyEvent(undefined, subEvents[0]!).project).toBe('xxxxxxxxxxxxxx');
  });
  it('Codex: project = session_meta.cwd', () => {
    const p = new CodexParser({ embedPrompts: false });
    fixture('codex/rollout-2026-09-29T10-00-00-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl').split('\n').forEach((l) => p.feed(l));
    expect(p.meta()).toEqual({ project: 'demo' });
  });
  it('estado: project se guarda, title NO; toView lo recibe de memoria', () => {
    const s = applyEvent(undefined, ev({ project: 'contextpilot', title: 'Secreto del usuario' }));
    expect(s.project).toBe('contextpilot');
    expect(JSON.stringify(s)).not.toContain('Secreto');
    const v = toView(s, Date.now(), { title: 'Monitor' });
    expect(v).toMatchObject({ project: 'contextpilot', title: 'Monitor', displayName: 'contextpilot — Monitor', cacheTtlMs: 300_000 });
    expect(toView(s).displayName).toBe('contextpilot');
  });
  it('validate: acepta project/title/promptContentWords, normaliza y rechaza tipos malos', () => {
    const r = validateTurnEvent({ ...ev(), project: 'C:\\x\\demo', title: ' Hola\nmundo ', promptContentWords: 4 });
    expect(r.ok && r.event).toMatchObject({ project: 'demo', title: 'Hola mundo', promptContentWords: 4 });
    expect(validateTurnEvent({ ...ev(), title: 3 }).ok).toBe(false);
    expect(validateTurnEvent({ ...ev(), promptContentWords: -1 }).ok).toBe(false);
  });
});

describe('R4 robusto (CP-064)', () => {
  const prompt = (text: string, over: Partial<TurnEvent> = {}): TurnEvent =>
    ev({ phase: 'prompt', promptEmbedding: embed(redact(text)), promptTokens: estimateTokens(text), promptContentWords: contentWordCount(text), tokens: { input: 0, output: 0, estimated: false }, contextSize: 0, ...over });
  const resp = () => ev({ contextSize: 120_000, tokens: { input: 10, output: 100, cacheRead: 119_890, cacheWrite: 0, estimated: false } });
  function session(prompts: string[]): SessionState {
    let s: SessionState | undefined;
    for (const p of prompts) s = applyEvent(applyEvent(s, prompt(p)), resp());
    return s!;
  }
  const fires = (prev: SessionState, e: TurnEvent) => !!R4.evaluate({ event: e, prev, state: applyEvent(prev, e), thresholds: R4.defaults, now: 0 });

  it('guarda los últimos 3 prompts', () => {
    const s = session(['uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciseis diecisiete', 'a b c'.repeat(30), 'otra cosa distinta para completar un prompt largo de verdad con muchas palabras', 'y una cuarta más con palabras suficientes para contar como prompt con contenido real']);
    expect(s.recentPrompts).toHaveLength(3);
  });

  it('caso del lead: pregunta corta en tema tras sesión larga sobre la app → no dispara', () => {
    const prev = session([
      'Construí la app de escritorio en Electron con un tray que muestre el consumo de tokens de cada sesión activa',
      'Agregá al dashboard una pestaña de estadísticas por regla y proveedor con ahorro estimado y exportación CSV',
      'Implementá el overlay del tray con la sugerencia vigente y los botones de aceptar, ignorar y posponer',
      'Hacé que el daemon difunda por WebSocket los cambios de sesión para que la UI de escritorio se actualice sola',
    ]);
    const e = prompt('que es esto? necesito una app con un monitor, lo tienes?');
    expect(e.promptContentWords).toBeLessThan(R4.defaults.minContentWords!);
    expect(fires(prev, e)).toBe(false);
    // Sin el filtro de palabras (fuente vieja sin conteo) el embedding sí la daba por tarea nueva.
    expect(fires(prev, { ...e, promptContentWords: undefined })).toBe(true);
  });

  it('parecido al último prompt aunque lejos del centroide → no dispara', () => {
    const prev = session([
      'Revisá la configuración de nginx del balanceador y los certificados TLS del entorno de staging',
      'Ajustá los timeouts del upstream de nginx y el keepalive de las conexiones al backend de staging',
      'Configurá los logs de acceso de nginx con formato JSON y rotación diaria en staging',
      'Armá un pipeline de CI en GitHub Actions que corra los tests de integración de la API de pagos',
    ]);
    const e = prompt('Agregá al pipeline de GitHub Actions un job que publique el reporte de tests de integración de pagos');
    expect(fires(prev, e)).toBe(false);
    const other = prompt('Escribime una receta de torta de chocolate sin harina con frutos rojos para el cumpleaños de mañana');
    expect(fires(prev, other)).toBe(true);
  });
});
