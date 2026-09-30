import { describe, expect, it } from 'vitest';
import {
  CACHE_READ_WEIGHT,
  COMPACT_KEEP,
  HANDOFF_TOKENS,
  SAVINGS_HORIZON,
  advisorCostRatio,
  contextTokenWeight,
  estimateSaving,
  realizedSavings,
} from '../src/index.js';
import { ev, run } from './helpers.js';

// Sesión con 100k de contexto, 90 % de caché → peso por token = 0,9·0,1 + 0,1 = 0,19.
const CTX = 100_000;
const base = () =>
  run([ev({ contextSize: CTX, tokens: { input: 10_000, output: 500, cacheRead: 90_000, cacheWrite: 0, estimated: false } })]).state;
const W = 0.9 * CACHE_READ_WEIGHT + 0.1;

describe('estimateSaving (DECISIONS «ahorro»: horizonte 10, cacheRead ×0,1)', () => {
  it('peso de contexto', () => {
    expect(contextTokenWeight(base())).toBeCloseTo(W);
    expect(contextTokenWeight({ cacheRatios: [], estimated: true })).toBe(1);
  });

  it('R1/G1/G2: compactar deja COMPACT_KEEP del contexto', () => {
    const v = Math.round(CTX * (1 - COMPACT_KEEP) * W * SAVINGS_HORIZON);
    expect(estimateSaving('R1', base())).toBe(v);
    expect(estimateSaving('G1', base())).toBe(v);
    expect(estimateSaving('G2', base())).toBe(v);
  });

  it('R2: re-escritura completa + 9 lecturas de caché evitadas', () => {
    expect(estimateSaving('R2', base())).toBe(Math.round((CTX - HANDOFF_TOKENS) * (1 + 0.1 * 9)));
  });

  it('R3: la parte no cacheada pasaría a caché', () => {
    const s = base();
    expect(estimateSaving('R3', s)).toBe(Math.round(CTX * (1 - 0.9) * 0.9 * SAVINGS_HORIZON));
  });

  it('R4 y W1: contexto previo reemplazado por traspaso', () => {
    expect(estimateSaving('R4', base())).toBe(Math.round((CTX - HANDOFF_TOKENS) * W * 10));
    expect(estimateSaving('W1', base())).toBe(Math.round((CTX - 3000) * W * 10));
  });

  it('R5: 80 % del resultado más grande', () => {
    const e = ev({ toolCalls: [{ name: 'Read', resultTokens: 20_000, failed: false, argsHash: '' }] });
    expect(estimateSaving('R5', base(), e)).toBe(Math.round(20_000 * 0.8 * W * 10));
  });

  it('R6: definiciones sin uso', () => {
    const s = { ...base(), turns: 25, toolsAvailable: [{ name: 'mcp__x', definitionTokens: 2000 }] };
    expect(estimateSaving('R6', s)).toBe(Math.round(2000 * W * 10));
  });

  it('R8: contexto reenviado en el horizonte', () => {
    expect(estimateSaving('R8', base())).toBe(Math.round(CTX * W * 10));
  });

  it('R9 y W2: bloque/adjunto repetido', () => {
    const s = { ...base(), blockCounts: { H: { count: 2, tokens: 3000 } } };
    expect(estimateSaving('R9', s, ev({ blocks: [{ hash: 'H', tokens: 3000 }] }))).toBe(Math.round(3000 * W * 10));
    expect(estimateSaving('R9', s)).toBe(Math.round(3000 * W * 10));
    expect(estimateSaving('W2', base(), ev({ attachments: [{ hash: 'A', tokens: 1000 }] }))).toBe(Math.round(1000 * W * 10));
  });

  it('W3: regeneraciones evitadas', () => {
    const s = { ...base(), regenerations: 3, lastOutputTokens: 500 };
    expect(estimateSaving('W3', s)).toBe(Math.round((CTX * W + 500) * 3));
  });

  it('R7, W4, R10 y reglas desconocidas: 0 (beneficio de precio, no de tokens)', () => {
    for (const id of ['R7', 'W4', 'R10', 'X']) expect(estimateSaving(id, base())).toBe(0);
  });
});

describe('realizedSavings / advisorCostRatio (CP-021.2/3)', () => {
  it('sólo accepted suma', () => {
    const r = realizedSavings([
      { ruleId: 'R1', estimatedSavingTokens: 1000, feedback: 'accepted', provider: 'anthropic' },
      { ruleId: 'R1', estimatedSavingTokens: 500, feedback: 'dismissed' },
      { ruleId: 'R5', estimatedSavingTokens: 300, feedback: 'snoozed' },
      { ruleId: 'R5', estimatedSavingTokens: 200, feedback: 'accepted', provider: 'openai' },
      { ruleId: 'R8', feedback: null },
    ]);
    expect(r).toEqual({ total: 1200, accepted: 2, byRule: { R1: 1000, R5: 200 }, byProvider: { anthropic: 1000, openai: 200 } });
  });
  it('cociente consumo propio / ahorro', () => {
    expect(advisorCostRatio(20, 1000)).toBe(0.02);
    expect(advisorCostRatio(20, 0)).toBeNull();
  });
});
