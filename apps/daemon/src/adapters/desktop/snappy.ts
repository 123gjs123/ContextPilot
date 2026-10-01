// Descompresor Snappy (formato «raw», sin framing) en JS puro. Lo usan los blobs de IndexedDB y los
// bloques .ldb de LevelDB (docs/SPIKE-desktop-traffic.md §1a). Lanza Error si el flujo es inválido.

function varint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('snappy: varint truncado');
    const b = buf[pos++]!;
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
    if (shift > 35) throw new Error('snappy: varint demasiado largo');
  }
}

export function snappyDecompress(src: Buffer): Buffer {
  const [len, start] = varint(src, 0);
  const out = Buffer.allocUnsafe(len);
  let o = 0;
  let p = start;
  while (p < src.length) {
    const tag = src[p++]!;
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n |= src[p + i]! << (8 * i);
        n >>>= 0;
        p += bytes;
      }
      n += 1;
      if (p + n > src.length || o + n > len) throw new Error('snappy: literal fuera de rango');
      src.copy(out, o, p, p + n);
      o += n;
      p += n;
      continue;
    }
    let n: number;
    let off: number;
    if (kind === 1) {
      n = ((tag >> 2) & 7) + 4;
      off = ((tag >> 5) << 8) | src[p++]!;
    } else if (kind === 2) {
      n = (tag >> 2) + 1;
      off = src.readUInt16LE(p);
      p += 2;
    } else {
      n = (tag >> 2) + 1;
      off = src.readUInt32LE(p);
      p += 4;
    }
    if (off === 0 || off > o || o + n > len) throw new Error('snappy: copia fuera de rango');
    // Copia byte a byte: las copias pueden solaparse (off < n).
    for (let i = 0; i < n; i++, o++) out[o] = out[o - off]!;
  }
  if (o !== len) throw new Error('snappy: largo inconsistente');
  return out;
}
