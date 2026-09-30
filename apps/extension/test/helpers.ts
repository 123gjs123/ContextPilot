import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(here, 'fixtures', name), 'utf8');
}

export type TestWindow = Window & typeof globalThis;

export function dom(html: string, url: string): { win: TestWindow; doc: Document; jsdom: JSDOM } {
  const jsdom = new JSDOM(html, { url, pretendToBeVisual: true });
  const win = jsdom.window as unknown as TestWindow;
  return { win, doc: win.document, jsdom };
}

/** Deja correr microtareas (callbacks de MutationObserver en jsdom). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** ReadableStream que emite los bytes en trozos de tamaño fijo (corta caracteres multibyte). */
export function chunkedStream(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(ctl) {
      if (i >= bytes.length) return ctl.close();
      ctl.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}
