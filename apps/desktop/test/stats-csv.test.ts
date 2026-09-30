import { describe, expect, it } from 'vitest';
import { csvCell, suggestionsCsv, SUGGESTION_CSV_COLUMNS } from '../src/shared/csv.js';
import { advisorKpi, filterSessions, statsQuery, statsView } from '../src/shared/stats.js';
import type { Stats } from '../src/shared/types.js';
import { sess, sug } from './helpers.js';

const stats: Stats = {
  byRule: [
    { ruleId: 'R5', fired: 2, accepted: 0, dismissed: 2, snoozed: 0, savedTokens: 0 },
    { ruleId: 'R1', fired: 10, accepted: 6, dismissed: 3, snoozed: 1, savedTokens: 120_000 },
  ],
  byProvider: [
    { provider: 'openai', sessions: 1, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, savedTokens: 0 },
    { provider: 'anthropic', sessions: 4, input: 10_000, output: 5000, cacheRead: 90_000, cacheWrite: 0, savedTokens: 120_000 },
  ],
  acceptanceRate: 0.5,
  suggestionsPerActiveHour: 4.2,
};

describe('stats → view model (CP-051)', () => {
  it('reglas ordenadas por disparos, aceptación por regla', () => {
    const v = statsView(stats);
    expect(v.rules.map((r) => r.ruleId)).toEqual(['R1', 'R5']);
    expect(v.rules[0]!.acceptanceText).toBe('60%');
    expect(v.rules[0]!.savedText).toBe('≈120k');
    expect(v.rules[1]!.acceptanceText).toBe('0%');
    expect(v.maxRuleSaved).toBe(120_000);
  });

  it('proveedores por ahorro, con caché', () => {
    const v = statsView(stats);
    expect(v.providers[0]!.provider).toBe('anthropic');
    expect(v.providers[0]!.cacheText).toBe('90%');
    expect(v.providers[1]!.cacheText).toBe('0%');
  });

  it('KPIs con objetivo del SPEC §11', () => {
    const k = Object.fromEntries(statsView(stats).kpis.map((x) => [x.label, x]));
    expect(k['Aceptación']!.status).toBe('ok');
    expect(k['Sugerencias por hora activa']!.status).toBe('bad');
    expect(k['Proporción de caché']!.value).toBe('89%');
  });

  it('sin datos no inventa cifras', () => {
    const v = statsView({ byRule: [], byProvider: [], acceptanceRate: 0, suggestionsPerActiveHour: NaN });
    expect(v.kpis.every((k) => k.status === 'none')).toBe(true);
    expect(v.kpis.find((k) => k.label === 'Aceptación')!.value).toBe('—');
  });

  it('consumo del asesor: rojo si ≥ 2 % (CP-051.2)', () => {
    expect(advisorKpi(undefined, 100).value).toBe('sin datos');
    expect(advisorKpi(1, 100).status).toBe('ok');
    expect(advisorKpi(2, 100).status).toBe('bad');
    expect(advisorKpi(5, 0).status).toBe('bad');
  });
});

describe('filtros de sesiones (CP-050.3)', () => {
  const list = [
    sess({ sessionId: 'a', provider: 'anthropic', source: 'claude-code', lastTurnAt: '2026-09-28T10:00:00' }),
    sess({ sessionId: 'b', provider: 'openai', source: 'codex', lastTurnAt: '2026-09-29T10:00:00' }),
    sess({ sessionId: 'c', provider: 'anthropic', source: 'web', lastTurnAt: '2026-09-30T10:00:00' }),
  ];
  it('por proveedor, fuente y fecha (inclusive)', () => {
    expect(filterSessions(list, { provider: 'anthropic' }).map((s) => s.sessionId)).toEqual(['c', 'a']);
    expect(filterSessions(list, { source: 'codex' }).map((s) => s.sessionId)).toEqual(['b']);
    expect(filterSessions(list, { from: '2026-09-29', to: '2026-09-29' }).map((s) => s.sessionId)).toEqual(['b']);
  });
  it('query de /stats', () => {
    expect(statsQuery({})).toBe('');
    expect(statsQuery({ from: '2026-09-29' })).toMatch(/^\?from=2026-09-2/);
  });
});

describe('CSV (CP-051.3)', () => {
  it('una fila por sugerencia, sin contenido, columnas documentadas', () => {
    const csv = suggestionsCsv([
      {
        session: sess(),
        suggestions: [
          { ...sug({ id: 'x2', createdAt: '2026-09-30T11:00:00Z', title: 'SECRETO', detail: 'contenido privado' }), feedback: 'accepted' },
          { ...sug({ id: 'x1', createdAt: '2026-09-30T10:00:00Z', estimatedSavingTokens: 500 }) },
        ],
      },
    ]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(SUGGESTION_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith('x1,R1,s1,anthropic,claude-code')).toBe(true);
    expect(lines[2]).toContain('accepted');
    expect(csv).not.toContain('SECRETO');
    expect(csv).not.toContain('privado');
    expect(csv).not.toContain('/compact');
  });
  it('escapa comillas y neutraliza fórmulas', () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell('=HYPERLINK()')).toBe("'=HYPERLINK()");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(undefined)).toBe('');
  });
});
