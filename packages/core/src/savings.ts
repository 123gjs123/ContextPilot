import type { Feedback, Provider, SessionState, TurnEvent } from './types.js';

// CP-021 / DECISIONS «ahorro»: fórmula de ahorro estimado por regla.
// - Horizonte fijo: las próximas SAVINGS_HORIZON llamadas.
// - Tokens que se leerían de caché pesan CACHE_READ_WEIGHT (×0,1); el resto pesa 1.
// - Sólo cuenta como ahorro realizado con feedback 'accepted'.
// Las cifras son estimaciones (se muestran con «≈»).

export const SAVINGS_HORIZON = 10;
export const CACHE_READ_WEIGHT = 0.1;
/** Fracción del contexto que sobrevive a una compactación (resumen + archivos recientes). */
export const COMPACT_KEEP = 0.25;
/** Tamaño típico de un resumen de traspaso (tokens). */
export const HANDOFF_TOKENS = 4000;

/**
 * Costo ponderado de reenviar un token de contexto en una llamada: la parte cacheada vale ×0,1.
 * Sin historia de caché (web, estimado) se asume que todo se paga completo.
 */
export function contextTokenWeight(state: Pick<SessionState, 'cacheRatios' | 'estimated'>): number {
  const r = state.cacheRatios.at(-1);
  if (r === undefined || state.estimated) return 1;
  return r * CACHE_READ_WEIGHT + (1 - r);
}

/** Tokens que desaparecen del contexto → ahorro sobre el horizonte. */
function dropped(tokens: number, weight: number, calls = SAVINGS_HORIZON): number {
  return Math.max(0, Math.round(tokens * weight * calls));
}

function biggestRecentToolResult(state: SessionState, event?: TurnEvent): number {
  const calls = event?.toolCalls?.length ? event.toolCalls : state.recentToolCalls;
  return calls.reduce((m, t) => Math.max(m, t.resultTokens), 0);
}

/**
 * Ahorro estimado (tokens ponderados) si el usuario acepta la sugerencia de `ruleId` ahora.
 * `event` es opcional y aporta detalle del disparo (toolCalls, bloques, adjuntos).
 * Reglas cuyo beneficio no es de tokens (R7/W4 precio por token, R10 proyección) devuelven 0.
 */
export function estimateSaving(ruleId: string, state: SessionState, event?: TurnEvent): number {
  const ctx = state.contextSize;
  const w = contextTokenWeight(state);
  switch (ruleId) {
    // Compactar: el contexto baja a COMPACT_KEEP en cada una de las próximas llamadas.
    case 'R1':
    case 'G1':
    case 'G2':
      return dropped(ctx * (1 - COMPACT_KEEP), w);
    // Caché vencida: la 1.ª llamada re-escribiría todo a precio completo, las 9 siguientes lo
    // leerían de caché. Con traspaso, sólo se envía el resumen.
    case 'R2': {
      const saved = Math.max(0, ctx - HANDOFF_TOKENS);
      return Math.round(saved * (1 + CACHE_READ_WEIGHT * (SAVINGS_HORIZON - 1)));
    }
    // Caché rota: arreglarla convierte la parte no cacheada en lecturas de caché.
    case 'R3': {
      const r = state.cacheRatios.at(-1) ?? 0;
      return dropped(ctx * (1 - r), 1 - CACHE_READ_WEIGHT);
    }
    // Tarea nueva: el contexto previo deja de enviarse (queda sólo el traspaso).
    case 'R4':
      return dropped(Math.max(0, ctx - HANDOFF_TOKENS), w);
    // Resultado grande: filtrarlo deja ~20 % en contexto.
    case 'R5':
      return dropped(biggestRecentToolResult(state, event) * 0.8, w);
    // Herramientas sin uso: sus definiciones dejan de enviarse (casi siempre cacheadas).
    case 'R6': {
      const unused = state.toolsAvailable.filter((t) => {
        const last = state.toolLastUsedTurn[t.name];
        return last === undefined || state.turns - last >= 20;
      });
      return dropped(
        unused.reduce((s, t) => s + t.definitionTokens, 0),
        w,
      );
    }
    // Loop: cortar evita que cada reintento reenvíe el contexto durante el horizonte.
    case 'R8':
      return dropped(ctx, w);
    // Bloque repetido: la copia extra sale del contexto.
    case 'R9': {
      const blocks = event?.blocks ?? [];
      const rep = blocks.length
        ? blocks.filter((b) => (state.blockCounts[b.hash]?.count ?? 0) >= 2).reduce((s, b) => s + b.tokens, 0)
        : Object.values(state.blockCounts)
            .filter((c) => c.count >= 2)
            .reduce((s, c) => s + c.tokens * (c.count - 1), 0);
      return dropped(rep, w);
    }
    // Chat web largo: el chat nuevo arranca con un resumen de ~3k.
    case 'W1':
      return dropped(Math.max(0, ctx - 3000), w);
    // Adjunto re-subido: en un Project/Gem no se vuelve a enviar como mensaje.
    case 'W2': {
      const att = (event?.attachments ?? []).reduce((s, a) => s + a.tokens, 0);
      return dropped(att, w);
    }
    // Regeneraciones: cada una reenvía el contexto y produce otra salida; se evita otra tanda igual.
    case 'W3':
      return Math.round((ctx * w + (state.lastOutputTokens ?? 0)) * state.regenerations);
    default:
      return 0;
  }
}

export interface SavingsRow {
  ruleId: string;
  estimatedSavingTokens?: number;
  feedback?: Feedback | 'expired' | null;
  provider?: Provider;
}

export interface RealizedSavings {
  total: number;
  accepted: number;
  byRule: Record<string, number>;
  byProvider: Partial<Record<Provider, number>>;
}

/** CP-021.2: sólo las sugerencias aceptadas suman ahorro realizado. */
export function realizedSavings(rows: SavingsRow[]): RealizedSavings {
  const out: RealizedSavings = { total: 0, accepted: 0, byRule: {}, byProvider: {} };
  for (const r of rows) {
    if (r.feedback !== 'accepted') continue;
    const v = Math.max(0, r.estimatedSavingTokens ?? 0);
    out.accepted += 1;
    out.total += v;
    out.byRule[r.ruleId] = (out.byRule[r.ruleId] ?? 0) + v;
    if (r.provider) out.byProvider[r.provider] = (out.byProvider[r.provider] ?? 0) + v;
  }
  return out;
}

/**
 * CP-021.3 / RNF-14: cociente consumo propio del asesor / ahorro realizado.
 * null si todavía no hay ahorro (evita dividir por cero).
 */
export function advisorCostRatio(advisorTokens: number, savedTokens: number): number | null {
  if (savedTokens <= 0) return null;
  return advisorTokens / savedTokens;
}
