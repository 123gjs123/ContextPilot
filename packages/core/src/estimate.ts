import type { Provider } from './types.js';

// Estimador de tokens sin vocabulario (RF-NOR-03). Objetivo: ±15 % frente al tokenizer real
// en texto mixto español/inglés/código. Cuenta palabras, números, puntuación y espacios con
// pesos calibrados por proveedor; CJK cuenta ~1 token por carácter.

const PROVIDER_FACTOR: Record<Provider, number> = {
  anthropic: 1.3, // calibrado con scripts/verify-estimator.ts (319 respuestas reales)
  openai: 1.0,
  google: 0.98,
};

const TOKEN_RE =
  /([぀-ヿ㐀-鿿가-힯])|([A-Za-zÀ-ÿ]+)|(\d+)|(\s+)|([^\sA-Za-z\d])/g;

/**
 * D-23: URLs y corridas alfanuméricas largas con letras y dígitos (hashes, ids, base64) se cobran por
 * longitud: el tokenizer las parte en trozos de ~3 caracteres, mientras que el conteo por palabras de
 * abajo las parte en muchos segmentos de 1 token (sobreestimaba +17 % en un listado de URLs real).
 * Calibrado con `tool_result` reales (delta de contexto entre llamadas): mediana +24,5 % → +0,6 % en
 * salidas con URLs/hashes, sin cambios en `scripts/verify-estimator.ts` (ver DECISIONS «estimador URLs»).
 */
const LONG_RUN_RE = /https?:\/\/[^\s"'<>)\]]+|[A-Za-z0-9_\-+/=]{16,}/g;
const LONG_RUN_CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string, provider: Provider = 'anthropic'): number {
  if (!text) return 0;
  let tokens = 0;
  if (text.length >= 16) {
    let runs = 0;
    const rest = text.replace(LONG_RUN_RE, (m) => {
      if (!/^https?:\/\//.test(m) && !(/\d/.test(m) && /[A-Za-z]/.test(m))) return m;
      runs += m.length;
      return ' ';
    });
    if (runs) {
      tokens += runs / LONG_RUN_CHARS_PER_TOKEN;
      text = rest;
    }
  }
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) tokens += 1;
    else if (m[2]) {
      const len = m[2].length;
      // palabras cortas ≈ 1 token; largas se parten cada ~4.2 caracteres
      tokens += len <= 5 ? 1 : Math.ceil(len / 4.2);
    } else if (m[3]) tokens += Math.ceil(m[3].length / 3);
    else if (m[4]) {
      // un espacio simple se funde con la palabra siguiente; saltos e indentación cuestan
      const ws = m[4];
      const newlines = (ws.match(/\n/g) || []).length;
      const spaces = ws.length - newlines;
      tokens += newlines + (spaces > 3 ? Math.ceil(spaces / 4) : 0);
    } else if (m[5]) tokens += 1;
  }
  return Math.max(1, Math.round(tokens * PROVIDER_FACTOR[provider]));
}
