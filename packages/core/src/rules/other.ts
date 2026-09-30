import { clearCommand, compactCommand } from '../actions.js';
import { cosine } from '../embed.js';
import { priceTiersFor } from '../models.js';
import { projectPlan } from '../projection.js';
import { promptTotal } from '../state.js';
import type { Rule, Source } from '../types.js';
import { fmtTokens } from '../util.js';

const ALL: Source[] = ['claude-code', 'codex', 'gemini-cli', 'proxy', 'web', 'desktop'];
const CHAT_UI: Source[] = ['web', 'desktop'];
const MIN = 60_000;
/** D-6: umbral de coseno de R4 elegido sobre el dataset etiquetado (precisión > 80 %). */
export const R4_COSINE = 0.3;

export const R4: Rule = {
  id: 'R4',
  phase: 2,
  sources: ALL,
  requiresExact: false,
  // D-6: cosine calibrado con packages/core/test/fixtures/r4/cases.json (ver DECISIONS «R4»).
  defaults: { cosine: R4_COSINE, minPrompts: 3, minContext: 20_000, minPromptTokens: 20 },
  defaultCooldownMs: 30 * MIN,
  on: ['prompt', 'response'],
  evaluate({ event, prev, thresholds }) {
    if (!event.promptEmbedding || !prev?.centroid) return null;
    // Evita doble evaluación: en 'response' sólo si no hubo evento 'prompt' previo.
    if ((event.phase ?? 'response') === 'response' && prev.lastPhase === 'prompt') return null;
    if ((event.promptTokens ?? 0) < thresholds.minPromptTokens!) return null;
    if (prev.centroidN < thresholds.minPrompts! || prev.contextSize < thresholds.minContext!) return null;
    const sim = cosine(event.promptEmbedding, prev.centroid);
    if (sim >= thresholds.cosine!) return null;
    const clear = clearCommand(event.source);
    return {
      severity: 'info',
      title: 'Tarea nueva: conviene sesión nueva',
      detail: `El prompt no se parece a lo que venían trabajando (similitud ${sim.toFixed(2)}). Arrastrar ${fmtTokens(prev.contextSize)} tokens de otra tarea cuesta y distrae al modelo.`,
      estimatedSavingTokens: prev.contextSize,
      // CP-019.3 / D-6: traspaso + sesión nueva (+ comando de limpieza en CLI).
      actions: [
        { kind: 'handoff', label: 'Generar traspaso' },
        { kind: 'open-session', label: 'Sesión nueva' },
        ...(clear ? [{ kind: 'copy' as const, label: `Copiar ${clear}`, payload: clear }] : []),
      ],
    };
  },
};

export const R10: Rule = {
  id: 'R10',
  phase: 1,
  sources: ALL,
  requiresExact: false,
  // D-5: ritmo de 60 min (error medido en plan-usage real: 19,6 % vs 20,8 % con 30 min; ver DECISIONS).
  defaults: { rateWindowMin: 60, minPoints: 3 },
  defaultCooldownMs: 60 * MIN,
  on: ['response'],
  // D-1: señal de cuenta, no de sesión: una por proveedor, fuera del cupo visible por sesión.
  scope: 'account',
  evaluate({ plan, usageWindow, now, thresholds }) {
    if (!plan || !usageWindow || usageWindow.points.length < thresholds.minPoints!) return null;
    const pts = usageWindow.points;
    if (plan.kind === 'subscription') {
      // D-15: todas las ventanas del plan (5 h + 7 días); gana la que se agota primero.
      const proj = projectPlan(plan, (k) => usageWindow.byWindow?.[k] ?? pts, now, thresholds.rateWindowMin! * MIN);
      const hit = proj.filter((p) => p.exhaustAt !== undefined).sort((a, b) => a.exhaustAt! - b.exhaustAt!)[0];
      if (!hit) return null;
      const hhmm = new Date(hit.exhaustAt!).toTimeString().slice(0, 5);
      const multi = proj.length > 1 ? ` (ventana de ${hit.label})` : '';
      const pctUnits = hit.budget === 100;
      const fmt = (x: number) => (pctUnits ? `${Math.round(x)} %` : fmtTokens(x));
      return {
        // CP-018.2: critical con la hora proyectada.
        severity: 'critical',
        title: `A este ritmo llegás al límite a las ${hhmm}${multi}`,
        detail: `Usaste ${fmt(hit.used)} de ${fmt(hit.budget)} en la ventana actual; ritmo de los últimos ${thresholds.rateWindowMin} min: ${fmt(hit.perHour)}/h. La ventana se renueva a las ${new Date(hit.windowEndsAt).toTimeString().slice(0, 5)}.`,
        actions: [{ kind: 'show-detail', label: 'Ver proyección' }],
      };
    }
    if (plan.kind === 'api' && plan.dailyBudgetUsd && plan.pricePerMTokIn) {
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const today = pts.filter((p) => p.ts >= dayStart.getTime());
      const spent = (today.reduce((s, p) => s + p.tokens, 0) / 1e6) * plan.pricePerMTokIn;
      const elapsed = now - dayStart.getTime();
      if (elapsed < 30 * MIN) return null;
      const projected = (spent / elapsed) * 86_400_000;
      if (projected <= plan.dailyBudgetUsd) return null;
      return {
        severity: spent >= plan.dailyBudgetUsd ? 'critical' : 'warn',
        title: `Proyección diaria US$${projected.toFixed(2)} supera el presupuesto`,
        detail: `Gastado hoy ≈ US$${spent.toFixed(2)} de US$${plan.dailyBudgetUsd.toFixed(2)}.`,
        actions: [{ kind: 'show-detail', label: 'Ver proyección' }],
      };
    }
    return null;
  },
};

export const W1: Rule = {
  id: 'W1',
  phase: 0,
  sources: CHAT_UI,
  requiresExact: false,
  defaults: { tokens: 80_000, turns: 40 },
  defaultCooldownMs: 30 * MIN,
  on: ['response'],
  evaluate({ state, thresholds }) {
    if (state.contextSize <= thresholds.tokens! && state.turns <= thresholds.turns!) return null;
    return {
      severity: 'warn',
      title: `Conversación de ≈${fmtTokens(state.contextSize)} tokens: chat nuevo con resumen`,
      detail: `Lleva ${state.turns} turnos. Cada mensaje reenvía toda la conversación y consume más de tu límite; un chat nuevo con un resumen de traspaso mantiene el contexto útil.`,
      estimatedSavingTokens: Math.max(0, state.contextSize - 3000),
      actions: [{ kind: 'handoff', label: 'Generar resumen' }],
    };
  },
};

export const W2: Rule = {
  id: 'W2',
  phase: 1,
  sources: CHAT_UI,
  requiresExact: false,
  defaults: { repeats: 2 },
  defaultCooldownMs: 60 * MIN,
  on: ['prompt', 'response'],
  evaluate({ event, state, thresholds, siteAttachmentCounts }) {
    // D-11: cuenta la conversación actual y, si el daemon la informa, el sitio entero en 7 días.
    const count = (h: string) => Math.max(state.attachmentCounts[h] ?? 0, siteAttachmentCounts?.[h] ?? 0);
    const hit = (event.attachments ?? []).find((a) => count(a.hash) >= thresholds.repeats!);
    if (!hit) return null;
    const where = event.client.includes('gemini') ? 'un Gem' : event.client.includes('chatgpt') ? 'un Project o GPT' : 'un Project';
    return {
      severity: 'info',
      title: 'Volviste a subir el mismo archivo',
      detail: `Si lo usás seguido, cargalo una vez en ${where} con archivos fijos.`,
      estimatedSavingTokens: hit.tokens,
      actions: [{ kind: 'show-detail', label: 'Cómo hacerlo' }],
    };
  },
};

export const W3: Rule = {
  id: 'W3',
  phase: 0,
  sources: CHAT_UI,
  requiresExact: false,
  defaults: { regenerations: 3 },
  defaultCooldownMs: 15 * MIN,
  on: ['response'],
  evaluate({ state, thresholds }) {
    if (state.regenerations < thresholds.regenerations!) return null;
    return {
      severity: 'info',
      title: `Regeneraste ${state.regenerations} veces la misma respuesta`,
      detail: 'Insistir rara vez cambia el resultado. Reformulá: decí qué estuvo mal, agregá un ejemplo del resultado esperado o acotá el formato.',
      actions: [
        { kind: 'copy', label: 'Copiar plantilla', payload: 'La respuesta anterior no sirve porque ___. Necesito ___. Ejemplo del formato esperado: ___' },
      ],
    };
  },
};

export const W4: Rule = {
  id: 'W4',
  phase: 1,
  sources: CHAT_UI,
  requiresExact: false,
  defaults: { promptTokens: 200 },
  defaultCooldownMs: 60 * MIN,
  on: ['prompt', 'response'],
  evaluate({ event, state, thresholds }) {
    if (!event.expensiveMode) return null;
    const p = event.promptTokens ?? state.lastPromptTokens;
    if (p === undefined || p >= thresholds.promptTokens!) return null;
    return {
      severity: 'info',
      title: `${event.expensiveMode} para una pregunta simple`,
      detail: 'Este modo consume bastante más de tu límite. Para pedidos cortos alcanza el modo normal.',
      actions: [{ kind: 'show-detail', label: 'Cambiar de modo' }],
    };
  },
};

export const G1: Rule = {
  id: 'G1',
  phase: 2,
  sources: ['gemini-cli', 'proxy'],
  requiresExact: true,
  defaults: { margin: 0.1 },
  defaultCooldownMs: 30 * MIN,
  on: ['response'],
  evaluate({ event, prev, thresholds }) {
    if (event.provider !== 'google') return null;
    const tiers = priceTiersFor(event.model, event.provider);
    const size = promptTotal(event);
    const prevSize = prev?.contextSize ?? 0;
    const tier = tiers.find((t) => size >= t * (1 - thresholds.margin!) && prevSize < t);
    if (!tier) return null;
    const crossed = size >= tier;
    const cmd = compactCommand(event.source);
    return {
      severity: 'warn',
      title: crossed ? `Cruzaste el tramo de ${fmtTokens(tier)}: precio mayor por token` : `A ${fmtTokens(tier - size)} del tramo de precio de ${fmtTokens(tier)}`,
      detail: `${event.model} cobra más por token cuando el prompt supera ${fmtTokens(tier)}. Comprimí antes de cruzarlo.`,
      actions: cmd ? [{ kind: 'copy', label: `Copiar ${cmd}`, payload: cmd }] : [{ kind: 'show-detail', label: 'Recortar prompt' }],
    };
  },
};

export const G2: Rule = {
  id: 'G2',
  phase: 2,
  sources: ['gemini-cli', 'proxy', 'web'],
  requiresExact: false,
  defaults: { tokens: 200_000 },
  defaultCooldownMs: 30 * MIN,
  on: ['response'],
  evaluate({ event, state, thresholds }) {
    if (event.provider !== 'google' || state.contextSize <= thresholds.tokens!) return null;
    const cmd = compactCommand(event.source);
    return {
      severity: 'warn',
      title: `${fmtTokens(state.contextSize)} tokens de contexto: comprimí`,
      detail: 'La ventana es enorme, así que el porcentaje engaña: la latencia y el costo por turno crecen con el tamaño absoluto.',
      estimatedSavingTokens: Math.round(state.contextSize * 0.7),
      actions: cmd ? [{ kind: 'copy', label: `Copiar ${cmd}`, payload: cmd }] : [{ kind: 'handoff', label: 'Chat nuevo con resumen' }],
    };
  },
};
