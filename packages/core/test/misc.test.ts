import { describe, expect, it } from 'vitest';
import { cosine, embed, EMBED_DIMS, estimateTokens, hash, redact, splitBlocks, ulid, updateCentroid } from '../src/index.js';

describe('estimateTokens (CP-005)', () => {
  it('cordura: vacío 0, crece con el texto, proveedor aplica factor', () => {
    expect(estimateTokens('')).toBe(0);
    const s = 'The quick brown fox jumps over the lazy dog. El zorro marrón salta sobre el perro.';
    const t = estimateTokens(s, 'openai');
    // ~4 caracteres por token en texto mixto: rango amplio de cordura
    expect(t).toBeGreaterThan(s.length / 8);
    expect(t).toBeLessThan(s.length / 2);
    expect(estimateTokens(s + s, 'openai')).toBeGreaterThan(t);
    expect(estimateTokens(s, 'anthropic')).toBeGreaterThan(t);
  });
  it('código y CJK', () => {
    expect(estimateTokens('const x = foo(bar, 42);\n  return x;')).toBeGreaterThan(8);
    expect(estimateTokens('日本語のテキスト', 'openai')).toBe(8);
  });
  it('100 k caracteres en < 50 ms', () => {
    const big = 'lorem ipsum dolor sit amet, consectetur 12345 {x: y}\n'.repeat(2000).slice(0, 100_000);
    const t0 = performance.now();
    estimateTokens(big);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('redact (CP-006)', () => {
  it('cada tipo de secreto queda [REDACTED:*] y el resto intacto', () => {
    const cases: [string, RegExp][] = [
      ['sk-ant-api03-' + 'a'.repeat(30), /\[REDACTED:anthropic-key\]/],
      ['sk-proj-' + 'b'.repeat(30), /\[REDACTED:openai-key\]/],
      ['AIza' + 'c'.repeat(35), /\[REDACTED:google-key\]/],
      ['ghp_' + 'd'.repeat(36), /\[REDACTED:github-token\]/],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', /\[REDACTED:jwt\]/],
      ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', /Bearer \[REDACTED:bearer\]/],
      ['password=hunter22', /password=\[REDACTED\]/],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', /\[REDACTED:private-key\]/],
    ];
    for (const [secret, re] of cases) {
      const out = redact(`antes ${secret} después`);
      expect(out).toMatch(re);
      expect(out.startsWith('antes ')).toBe(true);
      expect(out.endsWith(' después')).toBe(true);
    }
  });
  it('texto sin secretos no cambia', () => {
    const s = 'Refactor del parser: sin claves acá.';
    expect(redact(s)).toBe(s);
  });
});

describe('embed (CP-019)', () => {
  it('dimensión fija, normalizado; similar > disímil', () => {
    const a = embed('arreglar el parser de transcripts jsonl y deduplicar message id');
    const b = embed('el parser jsonl de transcripts duplica message id: arreglarlo');
    const c = embed('receta de torta de chocolate con harina y huevos');
    expect(a).toHaveLength(EMBED_DIMS);
    expect(cosine(a, a)).toBeCloseTo(1);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    expect(cosine(a, b)).toBeGreaterThan(0.3);
    expect(cosine(a, c)).toBeLessThan(0.3);
  });
  it('centroide incremental queda normalizado', () => {
    const c = updateCentroid(embed('uno dos tres'), 1, embed('cuatro cinco seis'));
    expect(cosine(c, c)).toBeCloseTo(1);
  });
});

describe('util y blocks', () => {
  it('hash estable y ulid ordenable', () => {
    expect(hash('abc')).toBe(hash('abc'));
    expect(hash('abc')).not.toBe(hash('abd'));
    expect(ulid(1000) < ulid(2000)).toBe(true);
    expect(ulid()).toHaveLength(26);
  });
  it('splitBlocks: bloque grande repetido tiene mismo hash', () => {
    const big = 'palabra '.repeat(800);
    const a = splitBlocks(`intro\n\n${big}`);
    const b = splitBlocks(`otra intro\n\n${big}`);
    expect(a.some((x) => b.some((y) => y.hash === x.hash))).toBe(true);
  });
});
