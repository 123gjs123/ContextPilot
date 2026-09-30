import { estimateTokens } from '../estimate.js';
import { hash } from '../util.js';

/**
 * Divide un prompt en bloques grandes (separados por línea en blanco o fences de código) y
 * devuelve hash + tokens de los que superan minTokens. Base de R9.
 */
export function splitBlocks(text: string, minTokens = 500): { hash: string; tokens: number }[] {
  const parts: string[] = [];
  const fence = /```[\s\S]*?```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    parts.push(...text.slice(last, m.index).split(/\n\s*\n/));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(...text.slice(last).split(/\n\s*\n/));
  const out: { hash: string; tokens: number }[] = [];
  // Además del bloque por párrafo, el prompt completo cuenta como bloque (pegado repetido).
  for (const p of [...parts, text]) {
    const t = p.trim();
    if (!t) continue;
    const tokens = estimateTokens(t);
    if (tokens >= minTokens) out.push({ hash: hash(t.replace(/\s+/g, ' ')), tokens });
  }
  const seen = new Set<string>();
  return out.filter((b) => (seen.has(b.hash) ? false : (seen.add(b.hash), true)));
}
