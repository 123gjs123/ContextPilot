import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ClaudeDesktopAdapter, type AdapterReport } from '../src/cdp/claudeDesktop.js';

// D-16 / CP-043.2: sin puerto CDP → health «no-data» y reintento periódico (60 s en producción).

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('ClaudeDesktopAdapter sin CDP', () => {
  it('reporta no-data y reintenta con el intervalo configurado; stop() corta los reintentos', async () => {
    const reports: AdapterReport[] = [];
    const a = new ClaudeDesktopAdapter({ port: await freePort(), retryMs: 40, emit: async () => undefined, onReport: (r) => reports.push(r) });
    a.start();
    await new Promise((r) => setTimeout(r, 400));
    a.stop();
    const n = reports.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(reports.every((r) => r.status === 'no-data' && r.detail === 'Puerto CDP no disponible')).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(reports.length).toBeLessThanOrEqual(n + 1);
  });
  it('markRefused → error y no vuelve a no-data en los reintentos', async () => {
    const reports: AdapterReport[] = [];
    const a = new ClaudeDesktopAdapter({ port: await freePort(), retryMs: 30, emit: async () => undefined, onReport: (r) => reports.push(r) });
    a.markRefused('rechazado por la app');
    a.start();
    await new Promise((r) => setTimeout(r, 200));
    a.stop();
    expect(a.report.status).toBe('error');
    expect(reports.filter((r) => r.status === 'no-data')).toHaveLength(0);
  });
});
