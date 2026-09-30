// CP-029.3 / CP-037.3: cola FIFO (máx. 500) y reintento con backoff ≤ 30 s.
import type { TurnEvent } from '@contextpilot/core';
import { describe, expect, it, vi } from 'vitest';
import { backoffMs, EventQueue, QUEUE_MAX, type SendResult } from '../src/bg/queue.js';

const ev = (i: number) => ({ id: String(i) }) as TurnEvent;

function memStore() {
  let saved: TurnEvent[] = [];
  return { load: async () => saved, save: async (e: TurnEvent[]) => void (saved = [...e]), get: () => saved };
}

describe('EventQueue', () => {
  it('backoff exponencial con tope de 30 s', () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(10)).toBe(30_000);
  });

  it('daemon caído: encola máx. 500 descartando los más viejos y reenvía al volver', async () => {
    const store = memStore();
    let up = false;
    const sent: string[] = [];
    const timers: (() => void)[] = [];
    const q = new EventQueue(
      store,
      async (events): Promise<SendResult> => {
        if (!up) return { ok: false, retry: true };
        sent.push(...events.map((e) => e.id));
        return { ok: true };
      },
      ((fn: () => void) => {
        timers.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as never,
    );
    for (let i = 0; i < 520; i++) await q.push([ev(i)]);
    expect(q.size).toBe(QUEUE_MAX);
    expect(store.get()[0]!.id).toBe('20'); // FIFO: se perdieron los 20 más viejos
    expect(timers.length).toBeGreaterThan(0);
    up = true;
    timers.shift()!();
    await vi.waitFor(() => expect(q.size).toBe(0));
    expect(sent[0]).toBe('20');
    expect(sent.at(-1)).toBe('519');
    expect(store.get()).toHaveLength(0);
  });

  it('rechazo definitivo (400) descarta el lote y sigue', async () => {
    const q = new EventQueue(memStore(), async () => ({ ok: false, retry: false }));
    await q.push([ev(1)]);
    expect(q.size).toBe(0);
  });
});
