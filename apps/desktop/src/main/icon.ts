import { deflateSync } from 'node:zlib';
import type { TrayColor } from '../shared/types.js';

// Ícono del tray generado en código (CP-046): PNG RGBA de un círculo con borde, sin archivos.

export const TRAY_RGB: Record<TrayColor, [number, number, number]> = {
  green: [0x1b, 0xaf, 0x7a],
  yellow: [0xed, 0xa1, 0x00],
  red: [0xe3, 0x49, 0x48],
  gray: [0x8a, 0x89, 0x85],
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** PNG de `size`×`size` con un disco del color dado, borde oscuro y antialias simple. */
export function circlePng(size: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = (size - 1) / 2;
  const r = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filtro None
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.max(0, Math.min(1, r - d + 0.5));
      const border = d > r - Math.max(1, size / 16);
      const k = border ? 0.6 : 1;
      const o = row + 1 + x * 4;
      raw[o] = Math.round(rgb[0] * k);
      raw[o + 1] = Math.round(rgb[1] * k);
      raw[o + 2] = Math.round(rgb[2] * k);
      raw[o + 3] = Math.round(alpha * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function trayPng(color: TrayColor, size = 32): Buffer {
  return circlePng(size, TRAY_RGB[color]);
}
