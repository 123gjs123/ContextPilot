import { snappyDecompress } from './snappy.js';
import { v8Deserialize } from './v8.js';

// Valores de IndexedDB de Chromium (docs/SPIKE-desktop-traffic.md §1a):
// - en el log de LevelDB: varint (versión IDB) + sobre Blink + serialización V8;
// - en archivos blob: `FF 11 02` + Snappy + (sobre Blink + V8).
// Sobre Blink: `FF <versión>` y, desde la versión 21, `FE` + 12 bytes de trailer. Luego `FF <v8>`.

/** Devuelve el valor JS o undefined si no es un valor serializado reconocible. Lanza con V8 roto. */
export function decodeIdbValue(raw: Buffer): unknown {
  let b = raw;
  if (b[0] === 0xff && b[1] === 0x11 && b[2] === 0x02) b = snappyDecompress(b.subarray(3));
  // Saltar la versión IDB (varint) hasta el sobre Blink.
  let i = 0;
  while (i < 4 && i < b.length && b[i] !== 0xff) i++;
  if (b[i] !== 0xff) return undefined;
  const blinkVersion = b[i + 1];
  if (blinkVersion === 0x11 && b[i + 2] === 0x02) return decodeIdbValue(b.subarray(i));
  let j = i + 2;
  if (b[j] === 0xfe) j += 1 + 12;
  if (b[j] !== 0xff) return undefined;
  return v8Deserialize(b.subarray(j));
}
