// Deserializador propio del formato ValueSerializer de V8 (subconjunto que usa el store de
// conversaciones de claude.ai). No depende de la versión de V8 de Node: acepta formatos 13..16.
// Soporta objetos, arrays densos y dispersos, strings (latin1, utf16, utf8), números, bigint
// (como número), booleanos, null/undefined, Date, Map, Set, objetos envoltorio y referencias.
// Cualquier otro tag lanza Error: el adaptador lo reporta como formato no soportado.

export class V8Reader {
  private pos = 0;
  private readonly objects: unknown[] = [];
  version = 0;

  constructor(private readonly buf: Buffer) {}

  private byte(): number {
    if (this.pos >= this.buf.length) throw new Error('v8: fin inesperado');
    return this.buf[this.pos++]!;
  }

  private varint(): number {
    let r = 0;
    let mul = 1;
    for (;;) {
      const b = this.byte();
      r += (b & 0x7f) * mul;
      if (!(b & 0x80)) return r;
      mul *= 128;
      if (mul > 2 ** 63) throw new Error('v8: varint demasiado largo');
    }
  }

  private zigzag(): number {
    const u = this.varint();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }

  private double(): number {
    if (this.pos + 8 > this.buf.length) throw new Error('v8: double truncado');
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  private bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error('v8: bytes truncados');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  /** Lee el encabezado `FF <versión>` (si está) y el valor. */
  read(): unknown {
    if (this.buf[this.pos] === 0xff) {
      this.pos++;
      this.version = this.varint();
      if (this.version < 13 || this.version > 16) throw new Error(`v8: versión de formato ${this.version} no soportada`);
    }
    return this.value();
  }

  private track<T>(v: T): T {
    this.objects.push(v);
    return v;
  }

  private value(): unknown {
    for (;;) {
      const tag = this.byte();
      switch (tag) {
        case 0x00: // padding
          continue;
        case 0x5f: // _ undefined
          return undefined;
        case 0x30: // 0 null
          return null;
        case 0x54: // T
          return true;
        case 0x46: // F
          return false;
        case 0x49: // I int32 zigzag
          return this.zigzag();
        case 0x55: // U uint32
          return this.varint();
        case 0x4e: // N double
          return this.double();
        case 0x5a: {
          // Z bigint: bitfield (largo*2 + signo) y dígitos de 64 bits LE → número aproximado.
          const bits = this.varint();
          const bytes = this.bytes(bits >> 1);
          let v = 0;
          for (let i = bytes.length - 1; i >= 0; i--) v = v * 256 + bytes[i]!;
          return bits & 1 ? -v : v;
        }
        case 0x22: // " one-byte (latin1)
          return this.bytes(this.varint()).toString('latin1');
        case 0x63: // c two-byte (utf16le)
          return this.bytes(this.varint()).toString('utf16le');
        case 0x53: // S utf8
          return this.bytes(this.varint()).toString('utf8');
        case 0x5e: {
          // ^ referencia a un objeto ya visto
          const id = this.varint();
          if (id >= this.objects.length) throw new Error('v8: referencia inválida');
          return this.objects[id];
        }
        case 0x6f: {
          // o objeto
          const o: Record<string, unknown> = this.track({});
          this.properties(o, 0x7b);
          return o;
        }
        case 0x41: {
          // A array denso
          const len = this.varint();
          const a: unknown[] = this.track(new Array(len));
          for (let i = 0; i < len; i++) {
            if (this.buf[this.pos] === 0x2d) {
              // - hueco
              this.pos++;
              continue;
            }
            a[i] = this.value();
          }
          this.properties(a as unknown as Record<string, unknown>, 0x24);
          this.varint(); // largo
          return a;
        }
        case 0x61: {
          // a array disperso
          const len = this.varint();
          const a: unknown[] = this.track(new Array(len));
          this.properties(a as unknown as Record<string, unknown>, 0x40);
          this.varint();
          return a;
        }
        case 0x44: // D fecha
          return this.track(new Date(this.double()));
        case 0x79: // y true object
          return this.track(true);
        case 0x7a: // z false object
          return this.track(false);
        case 0x6e: // n number object
          return this.track(this.double());
        case 0x73: {
          // s string object
          const s = this.value();
          return this.track(s);
        }
        case 0x3b: {
          // ; Map
          const m = this.track(new Map<unknown, unknown>());
          for (;;) {
            if (this.buf[this.pos] === 0x3a) {
              this.pos++;
              this.varint();
              return m;
            }
            const k = this.value();
            m.set(k, this.value());
          }
        }
        case 0x27: {
          // ' Set
          const s = this.track(new Set<unknown>());
          for (;;) {
            if (this.buf[this.pos] === 0x2c) {
              this.pos++;
              this.varint();
              return s;
            }
            s.add(this.value());
          }
        }
        case 0x52: {
          // R regexp: patrón + flags
          const src = this.value();
          this.varint();
          return this.track(String(src));
        }
        default:
          throw new Error(`v8: tag 0x${tag.toString(16)} no soportado en ${this.pos - 1}`);
      }
    }
  }

  /** Propiedades clave/valor hasta el tag de cierre; luego el conteo (se ignora). */
  private properties(o: Record<string, unknown>, end: number): void {
    for (;;) {
      if (this.buf[this.pos] === end) {
        this.pos++;
        this.varint();
        return;
      }
      const k = this.value();
      o[String(k)] = this.value();
    }
  }
}

export function v8Deserialize(buf: Buffer): unknown {
  return new V8Reader(buf).read();
}
