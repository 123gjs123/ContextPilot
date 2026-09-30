// Embedder local liviano (DECISIONS): hashing de palabras, bigramas y trigramas de caracteres en
// 256 dimensiones, normalizado L2. Sin descargas. Sirve para similitud temática gruesa (R4).
import { hash } from './util.js';

export const EMBED_DIMS = 256;

const STOP = new Set(
  'el la los las un una unos unas de del al y o que en con por para es son se lo le les su sus como mas pero si no ya muy este esta esto eso hay ahora favor puedes quiero necesito the a an of to in and or is are be it this that for on with as at by from not can you i we please'.split(
    ' ',
  ),
);

function bucket(token: string): number {
  return parseInt(hash(token).slice(-6), 16) % EMBED_DIMS;
}

function add(v: number[], i: number, w: number): void {
  v[i] = (v[i] ?? 0) + w;
}

export function embed(text: string): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0);
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  for (const w of words) {
    add(v, bucket('w:' + w), 2);
    const p = `^${w}$`;
    for (let i = 0; i + 3 <= p.length; i++) add(v, bucket('g:' + p.slice(i, i + 3)), 0.5);
  }
  for (let i = 0; i + 1 < words.length; i++) add(v, bucket('b:' + words[i] + ' ' + words[i + 1]), 1);
  return normalize(v);
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/** Centroide incremental (media de vectores normalizados), re-normalizado. */
export function updateCentroid(centroid: number[] | undefined, n: number, v: number[]): number[] {
  if (!centroid || n === 0) return v.slice();
  return normalize(centroid.map((c, i) => (c * n + (v[i] ?? 0)) / (n + 1)));
}
