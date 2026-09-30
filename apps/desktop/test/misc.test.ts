import { crc32 as zlibCrc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, trayPng } from '../src/main/icon.js';
import { isAllowedApi, loadSettings } from '../src/main/settings.js';
import { backoffDelay } from '../src/shared/backoff.js';
import { FUSE_SENTINEL, parseFuses } from '../src/shared/fuses.js';
import { parsePlanUsage } from '../src/shared/planUsage.js';
import { escapeXml, timelineModel, timelineSvg } from '../src/shared/timeline.js';
import { sug } from './helpers.js';

describe('fuses (CP-042)', () => {
  it('lee el centinela y los bytes de fuses de un buffer sintético', () => {
    const buf = Buffer.concat([Buffer.alloc(1000, 7), Buffer.from(FUSE_SENTINEL), Buffer.from([1, 9]), Buffer.from('010011011'), Buffer.alloc(50)]);
    const r = parseFuses(buf);
    expect(r.found).toBe(true);
    expect(r.offset).toBe(1000);
    expect(r.version).toBe(1);
    expect(r.raw).toBe('010011011');
    const byName = Object.fromEntries(r.fuses.map((f) => [f.name, f.state]));
    expect(byName.RunAsNode).toBe('disabled');
    expect(byName.EnableCookieEncryption).toBe('enabled');
    expect(byName.EnableNodeCliInspectArguments).toBe('disabled');
    expect(byName.EnableEmbeddedAsarIntegrityValidation).toBe('enabled');
    expect(byName.OnlyLoadAppFromAsar).toBe('enabled');
  });
  it('removido y ausente', () => {
    const r = parseFuses(Buffer.concat([Buffer.from(FUSE_SENTINEL), Buffer.from([1, 2]), Buffer.from('r1')]));
    expect(r.fuses[0]!.state).toBe('removed');
    expect(parseFuses(Buffer.from('nada')).found).toBe(false);
  });
});

describe('ícono del tray', () => {
  it('PNG válido con CRC correcto y alfa en esquinas', () => {
    const png = trayPng('red', 32);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(32);
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe((32 * 4 + 1) * 32);
    expect(raw[1 + 3]).toBe(0); // esquina transparente
    const mid = 16 * (32 * 4 + 1) + 1 + 16 * 4;
    expect([raw[mid], raw[mid + 3]]).toEqual([0xe3, 255]);
    expect(trayPng('green')).not.toEqual(trayPng('gray'));
  });
  it('crc32 coincide con zlib', () => {
    const b = Buffer.from('ContextPilot ≈');
    expect(crc32(b)).toBe(zlibCrc32(b));
  });
});

describe('settings y API permitida', () => {
  it('sólo rutas del contrato', () => {
    expect(isAllowedApi('GET', '/sessions?active=true')).toBe(true);
    expect(isAllowedApi('GET', '/sessions/claude.ai:abc')).toBe(true);
    expect(isAllowedApi('POST', '/suggestions/01ABC/feedback')).toBe(true);
    expect(isAllowedApi('POST', '/config/import?dryRun=true')).toBe(true);
    expect(isAllowedApi('POST', '/ingest/events')).toBe(false);
    expect(isAllowedApi('GET', '/proxy/anthropic/v1')).toBe(false);
    expect(isAllowedApi('DELETE', '/config')).toBe(false);
    expect(isAllowedApi('GET', '/sessions/../token')).toBe(false);
  });
  it('spawn del daemon apagado por defecto; env lo prende', () => {
    expect(loadSettings('Z:/no-existe', {}).spawnDaemon).toBe(false);
    expect(loadSettings('Z:/no-existe', { CONTEXTPILOT_SPAWN_DAEMON: '1' }).spawnDaemon).toBe(true);
  });
  it('backoff exponencial acotado', () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, () => 0.5)).toBe(8000);
    expect(backoffDelay(20, 1000, 30_000, () => 1)).toBe(36_000);
  });
});

describe('uso del plan de Claude Desktop (spike)', () => {
  it('toma la muestra más nueva y marca desactualizado', () => {
    const now = Date.parse('2026-09-30T08:00:00Z');
    const raw = JSON.stringify({ version: 2, samples: [{ t: now - 3_600_000, org: 'x', u: { fh: 50, sd: 30 } }, { t: now - 600_000, org: 'x', u: { fh: 12, sd: 33 } }, { t: 'mal' }] });
    expect(parsePlanUsage(raw, now)).toEqual({ fiveHourPct: 0.12, sevenDayPct: 0.33, sampledAt: new Date(now - 600_000).toISOString(), stale: false });
    expect(parsePlanUsage(raw, now + 3_600_000)!.stale).toBe(true);
    expect(parsePlanUsage('{', now)).toBeUndefined();
    expect(parsePlanUsage('{"samples":[]}', now)).toBeUndefined();
  });
});

describe('timeline (CP-050.1)', () => {
  const pts = [0, 1, 2].map((i) => ({
    ts: new Date(Date.UTC(2026, 8, 30, 10, i * 10)).toISOString(),
    contextSize: 50_000 * (i + 1),
    cacheRatio: i === 0 ? null : 0.9,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: false,
  }));
  it('escala contexto sobre la ventana y omite caché nula', () => {
    const m = timelineModel(pts, 200_000, [{ ...sug({ createdAt: pts[1]!.ts }), feedback: 'accepted' }], 700, 240);
    expect(m.context.map((p) => p.pct)).toEqual([0.25, 0.5, 0.75]);
    expect(m.cache).toHaveLength(2);
    expect(m.markers[0]).toMatchObject({ glyph: '✓', feedback: 'accepted' });
    expect(m.context[0]!.x).toBeLessThan(m.context[2]!.x);
    expect(m.context[0]!.y).toBeGreaterThan(m.context[2]!.y);
  });
  it('SVG escapa texto y muestra «sin datos» vacío', () => {
    const svg = timelineSvg(timelineModel(pts, 200_000, [sug({ createdAt: pts[0]!.ts, title: '<script>' })]));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(timelineSvg(timelineModel([], 200_000, []))).toContain('sin datos');
    expect(escapeXml(`"'&`)).toBe('&quot;&#39;&amp;');
  });
});
