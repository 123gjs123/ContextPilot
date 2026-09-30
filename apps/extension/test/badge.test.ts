import { describe, expect, it } from 'vitest';
import { BADGE_COLORS, badgeFor, levelFor } from '../src/bg/badge.js';

describe('badge (CP-049.1/.3)', () => {
  it('umbrales en 49,9 / 50 / 75 / 75,1', () => {
    expect(levelFor(49.9)).toBe('green');
    expect(levelFor(50)).toBe('yellow');
    expect(levelFor(75)).toBe('yellow');
    expect(levelFor(75.1)).toBe('red');
    expect(badgeFor(49.9).color).toBe(BADGE_COLORS.green);
    expect(badgeFor(50).color).toBe(BADGE_COLORS.yellow);
    expect(badgeFor(75).color).toBe(BADGE_COLORS.yellow);
    expect(badgeFor(75.1).color).toBe(BADGE_COLORS.red);
  });

  it('texto = % (≈ implícito, aclarado en el título)', () => {
    const b = badgeFor(68.4);
    expect(b.text).toBe('68%');
    expect(b.title).toContain('≈68');
    expect(badgeFor(0).text).toBe('0%');
  });

  it('sin datos → «?» gris', () => {
    expect(badgeFor(null)).toMatchObject({ text: '?', color: BADGE_COLORS.gray });
    expect(badgeFor(40, 'error')).toMatchObject({ text: '?', level: 'gray' });
    expect(badgeFor(40, 'no-data').title).toContain('sin datos');
    expect(badgeFor(Number.NaN).text).toBe('?');
  });
});
