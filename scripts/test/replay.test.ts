import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { replay, streamReplay } from '../lib/replay.ts';

// CP-003.2 / D-7: harness de replay sobre los fixtures del core.
const FX = join(__dirname, '..', '..', 'packages', 'core', 'test', 'fixtures');
const tmp = mkdtempSync(join(tmpdir(), 'cp-replay-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('replay()', () => {
  it('Claude Code: eventos, sugerencias por regla y métrica por hora activa', () => {
    const r = replay([join(FX, 'claude-code', 'session-main.jsonl'), join(FX, 'claude-code', 'session-subagent.jsonl')]);
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
    expect(r.events.some((e) => e.sidechain)).toBe(true);
    const m = r.perActiveHour;
    const hours = new Set(r.events.map((e) => Math.floor(Date.parse(e.ts) / 3_600_000)));
    expect(m.activeHours).toBe(hours.size);
    expect(m.suggestions).toBe(Object.values(r.suggestionsByRule).reduce((a, b) => a + b, 0));
    expect(m.suggestionsPerActiveHour).toBeCloseTo(m.suggestions / m.activeHours, 2);
    expect(m.turns).toBeGreaterThan(0);
    // Orden temporal (subagentes intercalados).
    const ts = r.events.map((e) => Date.parse(e.ts));
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it('Codex y Gemini CLI: mismos eventos que *.expected.json', () => {
    const codex = join(FX, 'codex', 'rollout-2026-09-29T10-00-00-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl');
    const rc = replay([codex], { sourceParser: 'codex' });
    const ec = JSON.parse(readFileSync(codex + '.expected.json', 'utf8'));
    expect(rc.events.map((e) => e.tokens)).toEqual(ec.map((e: any) => e.tokens));

    const gem = join(FX, 'gemini-cli', 'telemetry.log');
    const rg = replay([gem], { sourceParser: 'gemini-cli' });
    const eg = JSON.parse(readFileSync(gem + '.expected.json', 'utf8'));
    expect(rg.events.map((e) => e.tokens)).toEqual(eg.map((e: any) => e.tokens));
  });

  it('rules filtra el reporte; config desactiva reglas', () => {
    const f = [join(FX, 'claude-code', 'session-main.jsonl')];
    const all = replay(f);
    const fired = Object.keys(all.suggestionsByRule);
    const only = replay(f, { rules: ['NINGUNA'] });
    expect(only.suggestionsByRule).toEqual({});
    if (fired.length) {
      const id = fired[0]!;
      const off = replay(f, { config: { rules: { [id]: { enabled: false } } } as any });
      expect(off.suggestionsByRule[id]).toBeUndefined();
    }
  });

  it('archivo inexistente cuenta como error', () => {
    expect(replay([join(tmp, 'no.jsonl')]).errors).toEqual([{ file: join(tmp, 'no.jsonl'), count: 1 }]);
  });
});

describe('streamReplay()', () => {
  it('re-escribe el fixture por appends con una línea partida', async () => {
    const src = join(FX, 'claude-code', 'session-subagent.jsonl');
    const dest = join(tmp, 'live.jsonl');
    const chunks: string[] = [];
    const n = await streamReplay(src, dest, { speed: 0, onWrite: (c) => void chunks.push(c) });
    const lines = readFileSync(src, 'utf8').split('\n').filter(Boolean);
    expect(n).toBe(lines.length);
    expect(readFileSync(dest, 'utf8')).toBe(lines.join('\n') + '\n');
    expect(chunks.filter((c) => !c.endsWith('\n'))).toHaveLength(1);
    expect(chunks).toHaveLength(lines.length + 1);
  });
});
