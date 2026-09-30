// Los fixtures SSE de la extensión, parseados por el parser de core a través del wrapper, producen
// el *.expected.json (MANUAL: re-grabar los fixtures desde sesiones reales, ver docs/reports/extension.md).
import { createWebStreamParser } from '@contextpilot/core';
import { describe, expect, it } from 'vitest';
import type { BridgePayload, NetDoneMsg } from '../src/bridge.js';
import { installFetchWrapper } from '../src/capture/fetchWrapper.js';
import { chunkedStream, fixture } from './helpers.js';

const CASES = [
  ['claude.ai', 'claude-completion', 'https://claude.ai/api/organizations/o/chat_conversations/c/completion'],
  ['chatgpt.com', 'chatgpt-conversation', 'https://chatgpt.com/backend-api/f/conversation'],
] as const;

describe.each(CASES)('fixture SSE %s', (site, name, url) => {
  it.each([1, 7, 64, 4096])('trozos de %i bytes → expected.json', async (size) => {
    const body = new TextEncoder().encode(fixture(`${name}.sse`));
    const posted: BridgePayload[] = [];
    const win = { fetch: (async () => new Response(chunkedStream(body, size))) as unknown as typeof fetch, location: { href: `https://${site}/` } };
    installFetchWrapper(win, { site, createParser: createWebStreamParser, post: (m) => void posted.push(m) });
    await (await win.fetch(url, { method: 'POST', body: '{}' })).arrayBuffer();
    for (let i = 0; i < 100 && !posted.some((m) => m.kind === 'net-done'); i++) await new Promise((r) => setTimeout(r, 2));
    const done = posted.find((m) => m.kind === 'net-done') as NetDoneMsg;
    expect(done).toMatchObject(JSON.parse(fixture(`${name}.expected.json`)));
  });
});
