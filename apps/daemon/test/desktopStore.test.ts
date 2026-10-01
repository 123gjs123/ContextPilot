import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeIdbValue } from '../src/adapters/desktop/idbValue.js';
import { BLOCK, readLog } from '../src/adapters/desktop/ldbLog.js';
import { turnsFromRecord } from '../src/adapters/desktop/mapTurns.js';
import { snappyDecompress } from '../src/adapters/desktop/snappy.js';
import { DesktopStoreAdapter } from '../src/adapters/desktop/store.js';
import { v8Deserialize } from '../src/adapters/desktop/v8.js';
import { rmrf, startTestDaemon, tempDir, type TestDaemon } from './helpers.js';

// H-1: adaptador del store de Claude Desktop. Todo con datos sintéticos en carpetas temporales:
// nunca se lee el store real (CONTEXTPILOT_DESKTOP_IDB_DIR apunta a un temporal).

const dirs: string[] = [];
const daemons: TestDaemon[] = [];
afterEach(async () => {
  for (const t of daemons.splice(0)) await t.close();
  for (const d of dirs.splice(0)) rmrf(d);
});

// ---------- codificadores de prueba (inversos de lo que lee el adaptador) ----------

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

/** Snappy sólo con literales (válido para el descompresor). */
function snappyLiteral(data: Buffer): Buffer {
  const parts = [varint(data.length)];
  for (let i = 0; i < data.length; i += 60) {
    const chunk = data.subarray(i, i + 60);
    parts.push(Buffer.from([(chunk.length - 1) << 2]), chunk);
  }
  return Buffer.concat(parts);
}

/** Valor IDB como lo guarda Chromium: versión IDB + sobre Blink v21 (FE + trailer) + V8. */
function idbInline(v: unknown): Buffer {
  return Buffer.concat([Buffer.from([0x14, 0xff, 0x15, 0xfe]), Buffer.alloc(12), serialize(v)]);
}

/** Archivo blob: FF 11 02 + Snappy(sobre Blink + V8). */
function idbBlob(v: unknown): Buffer {
  const inner = Buffer.concat([Buffer.from([0xff, 0x15, 0xfe]), Buffer.alloc(12), serialize(v)]);
  return Buffer.concat([Buffer.from([0xff, 0x11, 0x02]), snappyLiteral(inner)]);
}

function writeBatch(seq: number, puts: [Buffer, Buffer][]): Buffer {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(seq), 0);
  head.writeUInt32LE(puts.length, 8);
  const body = puts.flatMap(([k, v]) => [Buffer.from([1]), varint(k.length), k, varint(v.length), v]);
  return Buffer.concat([head, ...body]);
}

/** Registros físicos del log (fragmenta en bloques de 32 KiB). `offset` = tamaño actual del archivo. */
function logRecords(batch: Buffer, offset: number): Buffer {
  const out: Buffer[] = [];
  let pos = offset;
  let rest = batch;
  let firstFrag = true;
  while (true) {
    const left = BLOCK - (pos % BLOCK);
    if (left < 7) {
      out.push(Buffer.alloc(left));
      pos += left;
      continue;
    }
    const n = Math.min(rest.length, left - 7);
    const last = n === rest.length;
    const type = firstFrag && last ? 1 : firstFrag ? 2 : last ? 4 : 3;
    const h = Buffer.alloc(7);
    h.writeUInt16LE(n, 4);
    h[6] = type;
    out.push(h, rest.subarray(0, n));
    pos += 7 + n;
    rest = rest.subarray(n);
    firstFrag = false;
    if (last) break;
  }
  return Buffer.concat(out);
}

// ---------- datos sintéticos ----------

const T0 = Date.now() - 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function coworkRecord(results: number, v = '2.2') {
  const events: any[] = [{ kind: 'message', seq: 1, serverCreatedAt: T0, payload: { type: 'system', subtype: 'init', model: 'claude-fable-5-1' } }];
  let seq = 2;
  for (let i = 0; i < results; i++) {
    const t = T0 + i * 10_000;
    events.push({ kind: 'message', seq: seq++, serverCreatedAt: t + 1000, payload: { type: 'user', message: { role: 'user', content: `pedido ${i}` } } });
    events.push({
      kind: 'message',
      seq: seq++,
      serverCreatedAt: t + 2000,
      payload: { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 3, output_tokens: 50, cache_read_input_tokens: 1000 } } },
    });
    events.push({ kind: 'message', seq: seq++, serverCreatedAt: t + 3000, payload: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, is_error: i === 1, content: 'x'.repeat(400) }] } } });
    events.push({
      kind: 'message',
      seq: seq++,
      dedupKey: `res-${i}`,
      serverCreatedAt: t + 5000,
      payload: {
        type: 'result',
        uuid: `res-${i}`,
        usage: { input_tokens: 5, output_tokens: 120, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, iterations: [{ input_tokens: 2, output_tokens: 70, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500 }], output_tokens_details: { thinking_tokens: 30 } },
        modelUsage: { 'claude-fable-5-1': { contextWindow: 1_000_000 } },
        duration_ms: 4000,
      },
    });
  }
  return { conversationUuid: 'cse_demo', product: 'cowork', v, writtenAt: Date.now(), tree: { kind: 'cowork_remote', v: 1, events } };
}

function chatRecord() {
  const h1 = { uuid: 'h1', sender: 'human', created_at: iso(T0), content: [{ type: 'text', text: 'hola '.repeat(40) }], parent_message_uuid: '00000000' };
  const a1 = { uuid: 'a1', sender: 'assistant', created_at: iso(T0 + 1000), stop_reason: 'end_turn', content: [{ type: 'text', text: 'respuesta '.repeat(100), start_timestamp: iso(T0 + 1000), stop_timestamp: iso(T0 + 6000) }], parent_message_uuid: 'h1' };
  const h2 = { uuid: 'h2', sender: 'human', created_at: iso(T0 + 20_000), content: [{ type: 'text', text: 'seguí' }], parent_message_uuid: 'a1' };
  const a2 = { uuid: 'a2', sender: 'assistant', created_at: iso(T0 + 21_000), stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok', start_timestamp: iso(T0 + 21_000), stop_timestamp: iso(T0 + 22_000) }], parent_message_uuid: 'h2' };
  const pending = { uuid: 'a3', sender: 'assistant', created_at: iso(T0 + 30_000), stop_reason: null, content: [], parent_message_uuid: 'h2' };
  return {
    conversationUuid: 'chat-1',
    product: 'chat',
    v: '2.2',
    writtenAt: Date.now(),
    tree: { uuid: 'chat-1', name: 'Plan de pruebas', model: 'claude-fable-5', current_leaf_message_uuid: 'a2', chat_messages: [h1, a1, h2, a2, pending] },
  };
}

// ---------- tests ----------

describe('decodificadores', () => {
  it('V8: roundtrip de lo que serializa Node (objetos, arrays, unicode, fechas, Map, Set, referencias)', () => {
    const shared = { k: 1 };
    const v = { s: 'ñandú 🚀', n: -3, f: 1.5, big: 2 ** 40, a: [1, 'x', null, undefined, true], d: new Date(5), m: new Map([['a', 1]]), set: new Set([1, 2]), r1: shared, r2: shared, sparse: Object.assign(new Array(3), { 1: 'y' }) };
    const out = v8Deserialize(serialize(v)) as any;
    expect(out.s).toBe('ñandú 🚀');
    expect(out.n).toBe(-3);
    expect(out.f).toBe(1.5);
    expect(out.big).toBe(2 ** 40);
    expect(out.a).toEqual([1, 'x', null, undefined, true]);
    expect(out.d.getTime()).toBe(5);
    expect(out.m.get('a')).toBe(1);
    expect([...out.set]).toEqual([1, 2]);
    expect(out.r1).toBe(out.r2);
    expect(out.sparse[1]).toBe('y');
  });

  it('V8: versión de formato fuera de rango lanza', () => {
    expect(() => v8Deserialize(Buffer.from([0xff, 0x30, 0x30]))).toThrow(/versión/);
  });

  it('Snappy: literales y copias solapadas', () => {
    expect(snappyDecompress(snappyLiteral(Buffer.from('hola mundo'))).toString()).toBe('hola mundo');
    // «ab» + copia de 6 con offset 2 → «abababab»
    const src = Buffer.from([8, (2 - 1) << 2, 0x61, 0x62, ((6 - 4) << 2) | 1, 2]);
    expect(snappyDecompress(src).toString()).toBe('abababab');
    expect(() => snappyDecompress(Buffer.from([5, 0x01, 0x00]))).toThrow();
  });

  it('IDB: valor inline (varint + Blink FE + V8) y blob (FF 11 02 + Snappy)', () => {
    expect(decodeIdbValue(idbInline({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeIdbValue(idbBlob({ b: 'x' }))).toEqual({ b: 'x' });
    expect(decodeIdbValue(Buffer.from([0x0a, 0x82, 0x01]))).toBeUndefined();
  });

  it('log LevelDB: registros fragmentados entre bloques y lectura incremental', () => {
    const big = Buffer.alloc(70_000, 7);
    let file = logRecords(writeBatch(1, [[Buffer.from('k1'), Buffer.from('v1')]]), 0);
    file = Buffer.concat([file, logRecords(writeBatch(2, [[Buffer.from('k2'), big]]), file.length)]);
    const all = readLog(file);
    expect(all.puts.map((p) => p.key.toString())).toEqual(['k1', 'k2']);
    expect(all.puts[1]!.value.length).toBe(70_000);
    // Archivo cortado a mitad del registro grande: no lo emite y pide releer desde su bloque.
    const cut = readLog(file.subarray(0, 40_000));
    expect(cut.puts.map((p) => p.key.toString())).toEqual(['k1']);
    expect(cut.resumeAt).toBe(0);
    const again = readLog(file.subarray(cut.resumeAt), cut.resumeAt);
    expect(again.puts.map((p) => p.key.toString())).toEqual(['k1', 'k2']);
  });
});

describe('mapeo a TurnEvent', () => {
  it('cowork: un turno por result, usage exacto, contexto de la última iteración, herramientas', () => {
    const t = turnsFromRecord(coworkRecord(2) as any);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({
      id: 'cd:cse_demo:res-0',
      source: 'desktop',
      client: 'claude-desktop',
      sessionId: 'cse_demo',
      model: 'claude-fable-5-1',
      tokens: { input: 5, output: 120, cacheRead: 2000, cacheWrite: 300, reasoning: 30, estimated: false },
      contextSize: 2 + 70 + 40_000 + 500,
      contextWindow: 1_000_000,
      windowSource: 'observed',
      project: 'Cowork',
    });
    expect(t[0]!.toolCalls).toEqual([expect.objectContaining({ name: 'Bash', failed: false, resultTokens: expect.any(Number) })]);
    expect(t[1]!.toolCalls![0]!.failed).toBe(true);
    // Pausa = inicio del pedido 2 − fin del turno 1.
    expect(t[1]!.idleSincePrevMs).toBe(10_000 + 1000 - 5000);
    expect(t[0]!.promptHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('chat: rama actual, tokens estimados, respuesta en curso fuera, título en memoria', () => {
    const t = turnsFromRecord(chatRecord() as any);
    expect(t.map((x) => x.id)).toEqual(['cd:chat-1:a1', 'cd:chat-1:a2']);
    expect(t[0]).toMatchObject({ model: 'claude-fable-5', project: 'Chat', title: 'Plan de pruebas', tokens: { estimated: true } });
    expect(t[0]!.ts).toBe(iso(T0 + 6000));
    expect(t[1]!.idleSincePrevMs).toBe(20_000 - 6000);
    expect(t[1]!.contextSize).toBeGreaterThan(t[0]!.contextSize);
  });

  it('ignora trees desconocidos', () => {
    expect(turnsFromRecord({ conversationUuid: 'x', product: 'hub', tree: { foo: 1 } })).toEqual([]);
  });
});

describe('DesktopStoreAdapter (store sintético)', () => {
  function fakeStore() {
    const root = tempDir('cp-cd-idb-');
    dirs.push(root);
    const ldb = join(root, 'https_claude.ai_0.indexeddb.leveldb');
    const blob = join(root, 'https_claude.ai_0.indexeddb.blob', '5', '01');
    mkdirSync(ldb, { recursive: true });
    mkdirSync(blob, { recursive: true });
    const log = join(ldb, '000151.log');
    writeFileSync(log, Buffer.alloc(0));
    let size = 0;
    let seq = 1;
    const put = (v: unknown) => {
      const rec = logRecords(writeBatch(seq++, [[Buffer.from(`key${seq}`), idbInline(v)]]), size);
      appendFileSync(log, rec);
      size += rec.length;
    };
    return { root, blob, put };
  }

  async function daemonWith(root: string) {
    const t = await startTestDaemon();
    daemons.push(t);
    const a = new DesktopStoreAdapter({ pipeline: t.d.pipeline, storage: t.d.storage, health: t.d.health, log: t.d.log, env: { CONTEXTPILOT_DESKTOP_IDB_DIR: root }, recentMs: 30 * 60_000 });
    return { t, a };
  }

  it('lee blobs y log, crea sesiones desktop sin duplicar y sigue lo nuevo', async () => {
    const s = fakeStore();
    writeFileSync(join(s.blob, '183'), idbBlob(coworkRecord(1)));
    s.put(chatRecord());
    // Un valor de otra object store (no conversación) en el blob de otra base: se ignora.
    mkdirSync(join(s.root, 'https_claude.ai_0.indexeddb.blob', '1', 'c0'), { recursive: true });
    writeFileSync(join(s.root, 'https_claude.ai_0.indexeddb.blob', '1', 'c0', 'c0a8'), idbBlob({ buster: 'x', clientState: {} }));
    const { t, a } = await daemonWith(s.root);

    a.tick();
    const cw = t.d.pipeline.getSession('cse_demo')!;
    expect(cw).toMatchObject({ source: 'desktop', turns: 1, model: 'claude-fable-5-1' });
    expect(t.d.pipeline.getSession('chat-1')?.turns).toBe(2);
    expect(t.d.health.get('desktop')?.status).toBe('ok');

    // Misma data otra vez: sin duplicados.
    a.tick();
    expect(t.d.pipeline.getSession('cse_demo')!.turns).toBe(1);

    // El writer reescribe el tree con un turno más (blob nuevo + put en el log).
    writeFileSync(join(s.blob, '184'), idbBlob(coworkRecord(2)));
    s.put({ conversationUuid: 'cse_demo', product: 'cowork', messageCount: 9 });
    a.tick();
    expect(t.d.pipeline.getSession('cse_demo')!.turns).toBe(2);

    const views = (await (await t.api('/sessions?active=true')).json()) as { sessionId: string; source: string; client: string }[];
    expect(views.find((v) => v.sessionId === 'cse_demo')).toMatchObject({ source: 'desktop', client: 'claude-desktop' });
  });

  it('un valor ajeno en la misma base de blobs no tapa las conversaciones', async () => {
    const s = fakeStore();
    mkdirSync(join(s.root, 'https_claude.ai_0.indexeddb.blob', '5', '00'), { recursive: true });
    writeFileSync(join(s.root, 'https_claude.ai_0.indexeddb.blob', '5', '00', '01'), idbBlob({ otraStore: true, items: [1, 2] }));
    writeFileSync(join(s.blob, '183'), idbBlob(coworkRecord(2)));
    const { t, a } = await daemonWith(s.root);
    a.tick();
    expect(t.d.pipeline.getSession('cse_demo')?.turns).toBe(2);
  });

  it('formato desconocido: health en error y sin cifras', async () => {
    const s = fakeStore();
    writeFileSync(join(s.blob, '183'), idbBlob(coworkRecord(1, '3.0')));
    const { t, a } = await daemonWith(s.root);
    a.tick();
    expect(t.d.health.get('desktop')).toMatchObject({ status: 'error' });
    expect(t.d.pipeline.getSession('cse_demo')).toBeUndefined();
  });

  it('sin Claude Desktop instalado: no-data', async () => {
    const { t, a } = await daemonWith(join(tempDir('cp-none-'), 'nada'));
    a.tick();
    expect(t.d.health.get('desktop')).toMatchObject({ status: 'no-data' });
  });
});

describe('aislamiento', () => {
  it('bajo vitest, sin carpeta explícita, no busca el store real', async () => {
    const { desktopIdbDirs } = await import('../src/adapters/desktop/store.js');
    expect(desktopIdbDirs({ LOCALAPPDATA: '/tmp/x' })).toEqual([]);
    expect(desktopIdbDirs({ CONTEXTPILOT_DESKTOP_IDB_DIR: '/tmp/y' })).toEqual(['/tmp/y']);
  });
});
