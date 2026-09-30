// Lectura de Electron fuses (CP-042): el binario contiene el centinela seguido de
// [versión:1 byte][cantidad:1 byte][fuse_0..fuse_n-1], cada fuse '0' (off), '1' (on) o 'r' (removido).

export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

/** Orden de FuseV1Options (@electron/fuses). */
export const FUSE_NAMES_V1 = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
] as const;

export type FuseState = 'enabled' | 'disabled' | 'removed' | 'unknown';

export interface FuseReport {
  found: boolean;
  offset?: number;
  version?: number;
  raw?: string;
  fuses: { index: number; name: string; state: FuseState }[];
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function parseFuses(buf: Uint8Array): FuseReport {
  const sentinel = new TextEncoder().encode(FUSE_SENTINEL);
  const off = indexOfBytes(buf, sentinel);
  if (off < 0) return { found: false, fuses: [] };
  const p = off + sentinel.length;
  const version = buf[p];
  const count = buf[p + 1] ?? 0;
  const bytes = buf.slice(p + 2, p + 2 + count);
  const raw = String.fromCharCode(...bytes);
  const fuses = [...bytes].map((b, index) => ({
    index,
    name: version === 1 ? (FUSE_NAMES_V1[index] ?? `fuse_${index}`) : `fuse_${index}`,
    state: (b === 0x31 ? 'enabled' : b === 0x30 ? 'disabled' : b === 0x72 ? 'removed' : 'unknown') as FuseState,
  }));
  return { found: true, offset: off, version, raw, fuses };
}
