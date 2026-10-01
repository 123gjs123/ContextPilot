// Lector del write-ahead log de LevelDB (NNNNNN.log): bloques de 32 KiB con registros
// FULL/FIRST/MIDDLE/LAST; cada registro completo es un WriteBatch (seq, count, put/delete).
// Incremental: se le pasa el buffer desde un offset alineado a bloque y devuelve hasta dónde leyó
// registros completos, para seguir desde ahí en la próxima pasada.

export const BLOCK = 32 * 1024;
const HEADER = 7;

export interface LdbPut {
  key: Buffer;
  value: Buffer;
}

export interface LogRead {
  puts: LdbPut[];
  /** Offset absoluto (alineado a bloque) desde el que conviene releer la próxima vez. */
  resumeAt: number;
}

function varint32(buf: Buffer, pos: number): [number, number] {
  let r = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('ldb: varint truncado');
    const b = buf[pos++]!;
    r |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [r >>> 0, pos];
    shift += 7;
    if (shift > 28) throw new Error('ldb: varint demasiado largo');
  }
}

/** Entradas de un WriteBatch. Los delete se ignoran (no hacen falta para leer altas). */
export function parseWriteBatch(rec: Buffer): LdbPut[] {
  if (rec.length < 12) return [];
  const count = rec.readUInt32LE(8);
  const out: LdbPut[] = [];
  let p = 12;
  for (let i = 0; i < count && p < rec.length; i++) {
    const tag = rec[p++]!;
    let klen: number;
    [klen, p] = varint32(rec, p);
    const key = rec.subarray(p, p + klen);
    p += klen;
    if (tag === 1) {
      let vlen: number;
      [vlen, p] = varint32(rec, p);
      out.push({ key, value: rec.subarray(p, p + vlen) });
      p += vlen;
    } else if (tag !== 0) {
      break;
    }
  }
  return out;
}

/**
 * Lee registros desde `buf` (que empieza en el offset absoluto `base`, múltiplo de BLOCK). Un
 * registro fragmentado que no terminó queda para la próxima lectura (resumeAt = su primer bloque).
 */
export function readLog(buf: Buffer, base = 0): LogRead {
  const puts: LdbPut[] = [];
  let pos = 0;
  let pending: Buffer[] = [];
  let pendingStart = -1;
  let resumeAt = base;
  while (pos + HEADER <= buf.length) {
    const inBlock = pos % BLOCK;
    if (BLOCK - inBlock < HEADER) {
      pos += BLOCK - inBlock;
      continue;
    }
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6]!;
    if (type === 0 && len === 0) {
      // Relleno (prealocado): saltar al próximo bloque.
      pos += BLOCK - inBlock;
      continue;
    }
    if (pos + HEADER + len > buf.length) break;
    const data = buf.subarray(pos + HEADER, pos + HEADER + len);
    const recStart = pos;
    pos += HEADER + len;
    if (type === 1) {
      puts.push(...safeBatch(data));
      pending = [];
      pendingStart = -1;
      resumeAt = base + Math.floor(pos / BLOCK) * BLOCK;
    } else if (type === 2) {
      pending = [data];
      pendingStart = recStart;
    } else if (type === 3) {
      if (pendingStart >= 0) pending.push(data);
    } else if (type === 4) {
      if (pendingStart >= 0) {
        pending.push(data);
        puts.push(...safeBatch(Buffer.concat(pending)));
        resumeAt = base + Math.floor(pos / BLOCK) * BLOCK;
      }
      pending = [];
      pendingStart = -1;
    } else {
      break;
    }
  }
  if (pendingStart >= 0) resumeAt = base + Math.floor(pendingStart / BLOCK) * BLOCK;
  return { puts, resumeAt };
}

function safeBatch(rec: Buffer): LdbPut[] {
  try {
    return parseWriteBatch(rec);
  } catch {
    return [];
  }
}
