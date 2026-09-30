import { describe, expect, it } from 'vitest';
import { aggregateTeam, isoWeek, mergeTeamExports, ulid, type TeamSessionRow, type TeamSuggestionRow } from '../src/index.js';

const uuid = (i: number) => `5973b6c0-94b8-487b-a530-${String(i).padStart(12, '0')}`;

function data() {
  const sessions: TeamSessionRow[] = [];
  const suggestions: TeamSuggestionRow[] = [];
  // 6 sesiones anthropic en la semana 40 (visible), 2 openai (suprimido)
  for (let i = 0; i < 6; i++) {
    sessions.push({ sessionId: uuid(i), provider: 'anthropic', startedAt: '2026-09-29T10:00:00Z', totals: { input: 100, output: 10, cacheRead: 1000, cacheWrite: 50, reasoning: 0 } });
    suggestions.push({ sessionId: uuid(i), ruleId: 'R1', feedback: i < 3 ? 'accepted' : 'dismissed', estimatedSavingTokens: 1000 });
  }
  suggestions.push({ sessionId: uuid(0), ruleId: 'R8', feedback: 'accepted', estimatedSavingTokens: 5000 });
  for (let i = 10; i < 12; i++) sessions.push({ sessionId: ulid(), provider: 'openai', startedAt: '2026-09-30T10:00:00Z', input: 5, output: 5 });
  return { sessions, suggestions };
}

describe('isoWeek', () => {
  it('semanas ISO', () => {
    expect(isoWeek('2026-09-29T10:00:00Z')).toBe('2026-W40');
    expect(isoWeek('2027-01-01T00:00:00Z')).toBe('2026-W53');
    expect(isoWeek('nope')).toBe('unknown');
  });
});

describe('aggregateTeam (CP-057)', () => {
  const out = aggregateTeam({ ...data(), now: Date.parse('2026-10-01T12:00:00Z') });

  it('agrega por semana/proveedor y semana/regla', () => {
    expect(out.byProvider).toEqual([
      { week: '2026-W40', provider: 'anthropic', sessions: 6, input: 600, output: 60, cacheRead: 6000, cacheWrite: 300, suggestions: 7, accepted: 4, dismissed: 3, snoozed: 0, savedTokens: 8000 },
    ]);
    expect(out.byRule).toEqual([
      { week: '2026-W40', ruleId: 'R1', sessions: 6, fired: 6, accepted: 3, dismissed: 3, snoozed: 0, acceptanceRate: 0.5, savedTokens: 3000 },
    ]);
  });

  it('suprime buckets < 5 sesiones (openai y R8 con 1 sesión)', () => {
    expect(out.suppressedBuckets).toBe(2);
    expect(out.byProvider.some((b) => b.provider === 'openai')).toBe(false);
  });

  it('test de fuga: sin ids, hashes hex ≥ 16, ULID/UUID ni rutas', () => {
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/[0-9a-f]{16,}/i);
    expect(json).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(json).not.toMatch(/[\\/]{1,2}(Users|home)|[A-Z]:\\/);
    expect(json).not.toContain('sessionId');
  });

  it('filtro por rango de fechas', () => {
    const none = aggregateTeam({ ...data(), from: '2026-10-05T00:00:00Z' });
    expect(none.byProvider).toEqual([]);
    expect(none.byRule).toEqual([]);
  });
});

describe('mergeTeamExports', () => {
  it('suma buckets de N exportaciones y recalcula tasas', () => {
    const a = aggregateTeam(data());
    const b = aggregateTeam(data());
    const m = mergeTeamExports([a, b, { schema: 'otro' } as any]);
    expect(m.contributors).toBe(2);
    expect(m.byProvider[0]).toMatchObject({ sessions: 12, input: 1200, savedTokens: 16000 });
    expect(m.byRule[0]).toMatchObject({ fired: 12, accepted: 6, acceptanceRate: 0.5 });
    expect(m.suppressedBuckets).toBe(4);
    expect(m.weeks).toEqual(['2026-W40']);
  });
});
