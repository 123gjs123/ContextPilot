import { describe, expect, it } from 'vitest';
import { initialState, reduce, setConnection } from '../src/shared/store.js';
import { meterLevel, sessionRows, trayColor, trayMenuModel, trayTooltip } from '../src/shared/view.js';
import { NOW, sess, sug } from './helpers.js';
import type { AdapterHealth } from '../src/shared/types.js';

function st(sessions = [sess()], suggestions = [] as ReturnType<typeof sug>[], health: AdapterHealth[] = []) {
  return reduce(initialState(), { type: 'hello', data: { version: '1', sessions, suggestions, health } });
}

describe('medidor y color del tray (CP-046)', () => {
  it('umbrales del medidor SPEC §9', () => {
    expect(meterLevel(0.49)).toBe('green');
    expect(meterLevel(0.5)).toBe('yellow');
    expect(meterLevel(0.75)).toBe('yellow');
    expect(meterLevel(0.76)).toBe('red');
  });

  it('gris sin daemon', () => {
    expect(trayColor(setConnection(st(), 'unavailable'), NOW)).toBe('gray');
    expect(trayColor(initialState(), NOW)).toBe('gray');
  });

  it('gris conectado sin sesiones; verde con sesión sana', () => {
    expect(trayColor(st([]), NOW)).toBe('gray');
    expect(trayColor(st(), NOW)).toBe('green');
  });

  it('peor sesión gana; la severidad de la sugerencia sube el color', () => {
    expect(trayColor(st([sess(), sess({ sessionId: 's2', contextPct: 0.6 })]), NOW)).toBe('yellow');
    expect(trayColor(st([sess(), sess({ sessionId: 's2', contextPct: 0.9 })]), NOW)).toBe('red');
    expect(trayColor(st([sess()], [sug({ severity: 'critical' })]), NOW)).toBe('red');
    expect(trayColor(st([sess()], [sug({ severity: 'critical', quiet: true })]), NOW)).toBe('green');
  });

  it('sesión con adaptador roto → «sin datos» y no cuenta para el color', () => {
    const s = st([sess({ contextPct: 0.95 })], [sug()], [{ name: 'claude-code', status: 'error' }]);
    const rows = sessionRows(s, NOW);
    expect(rows[0]!.meterText).toBe('sin datos');
    expect(rows[0]!.noData).toBe(true);
    expect(rows[0]!.suggestion).toBeUndefined();
    expect(trayColor(s, NOW)).toBe('gray');
  });

  it('estimado se muestra con ≈', () => {
    const rows = sessionRows(st([sess({ estimated: true, contextPct: 0.45, source: 'web', client: 'claude.ai' })]), NOW);
    expect(rows[0]!.meterText).toBe('≈45%');
    expect(rows[0]!.cacheText).toBe('caché 90%');
  });

  it('health por prefijo de fuente (web:claude.ai)', () => {
    const s = st([sess({ source: 'web', client: 'chatgpt.com' })], [], [{ name: 'web:chatgpt.com', status: 'no-data' }]);
    expect(sessionRows(s, NOW)[0]!.noData).toBe(true);
  });

  it('fila con sugerencia expone acciones indexadas', () => {
    const rows = sessionRows(st([sess()], [sug({ estimatedSavingTokens: 42_000 })]), NOW);
    expect(rows[0]!.suggestion?.actions).toEqual([{ index: 0, kind: 'copy', label: 'Copiar /compact' }]);
    expect(rows[0]!.suggestion?.savingText).toBe('ahorro ≈42k tokens');
  });

  it('tooltip ≤ 127 caracteres y menú con sesiones', () => {
    const many = Array.from({ length: 12 }, (_, i) => sess({ sessionId: `sesion-larguisima-${i}`, client: 'cliente-con-nombre-largo' }));
    const s = st(many);
    expect(trayTooltip(s, NOW).length).toBeLessThanOrEqual(127);
    expect(trayTooltip(setConnection(s, 'unavailable'), NOW)).toContain('daemon no disponible');
    const menu = trayMenuModel(s, NOW);
    expect(menu.filter((m) => m.id?.startsWith('session:')).length).toBe(10);
    expect(menu.at(-1)?.id).toBe('quit');
    expect(trayMenuModel(setConnection(s, 'unavailable'), NOW)[0]!.label).toBe('Daemon no disponible');
  });
});
