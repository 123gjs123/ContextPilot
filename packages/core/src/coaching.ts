import { clearCommand, compactCommand, isChatUi, isCli } from './actions.js';
import { isTopTier, smallerModelFor } from './models.js';
import { R1, R2 } from './rules/cli.js';
import { W1 } from './rules/other.js';
import type { SessionView } from './state.js';
import type { Suggestion } from './types.js';
import { fmtPct, fmtTokens } from './util.js';

// CP-060: coaching proactivo. Todo el texto de «buena práctica» por regla vive acá (puro, testeado)
// para que el dashboard y, más adelante, el side panel de la extensión digan lo mismo.
// - coachingFor(ruleId, ctx): qué pasa (con los números de la sesión), por qué cuesta, qué hacer
//   ahora y un hábito para la próxima.
// - tipFor(view, now): consejo contextual cuando no hay sugerencia vigente (o null).
// Las cifras de umbrales salen de las reglas (defaults), no se repiten a mano.

export interface Coaching {
  /** Qué está pasando, con los números de la sesión. */
  what: string;
  /** Por qué cuesta, en una o dos frases. */
  why: string;
  /** Qué hacer ahora (los botones de acción van aparte). */
  action: string;
  /** Hábito de una línea para evitarlo la próxima vez. */
  habit: string;
}

export interface CoachingContext {
  view?: Pick<SessionView, 'source' | 'model' | 'provider' | 'contextSize' | 'contextWindow' | 'contextPct' | 'cachePct' | 'turns' | 'lastTurnAt' | 'estimated'> &
    Partial<Pick<SessionView, 'cacheTtlMs'>>;
  suggestion?: Pick<Suggestion, 'title' | 'detail'> & Partial<Pick<Suggestion, 'estimatedSavingTokens'>>;
  now?: number;
}

const MIN = 60_000;

interface Copy {
  why: string;
  action: string;
  habit: string;
  what?: (c: Required<Pick<CoachingContext, 'now'>> & CoachingContext) => string | undefined;
}

const approx = (v?: CoachingContext['view']) => (v?.estimated ? '≈' : '');

function ctxText(v: NonNullable<CoachingContext['view']>): string {
  return `${approx(v)}${fmtTokens(v.contextSize)} de ${fmtTokens(v.contextWindow)} tokens`;
}

function ttlLabel(ms: number | undefined): string {
  const t = ms || 5 * MIN;
  return t >= 60 * MIN ? '1 h' : `${Math.round(t / MIN)} min`;
}

const COPY: Record<string, Copy> = {
  R1: {
    what: ({ view }) => (view?.contextWindow ? `El contexto está al ${approx(view)}${fmtPct(view.contextPct)} (${ctxText(view)}).` : undefined),
    why: 'Cada mensaje reenvía todo ese contexto: cuanto más lleno, más caro cada turno y más cerca de la compactación automática, que resume sin saber qué te importa.',
    action: 'Copiá el comando de compactación (en Claude Code ya viene con foco en tus archivos recientes) y pegalo en la sesión; o generá un foco sugerido.',
    habit: `Compactá con foco apenas pases el ${fmtPct(R1.defaults.pct!)}, no esperes a la compactación automática.`,
  },
  R2: {
    what: ({ view, now }) => {
      if (!view) return undefined;
      const idle = Math.max(0, Math.round((now - Date.parse(view.lastTurnAt)) / MIN));
      return `Pasaron ${idle} min sin actividad y la caché (TTL ${ttlLabel(view.cacheTtlMs)}) expiró: el próximo mensaje vuelve a escribir ${approx(view)}${fmtTokens(view.contextSize)} tokens de contexto.`;
    },
    why: 'Escribir la caché cuesta bastante más que leerla. Retomar «en frío» una sesión grande sale más caro que empezar de cero con un buen resumen.',
    action: 'Generá un traspaso (queda en el portapapeles) y abrí una sesión nueva; o limpiá la sesión con el comando de limpieza.',
    habit: 'Antes de una pausa larga, cerrá con un traspaso; si retomás rápido, hacelo antes de que venza la caché.',
  },
  R3: {
    what: ({ view }) =>
      view && view.cachePct !== null ? `Sólo el ${fmtPct(view.cachePct)} del contexto salió de caché en los últimos turnos, y antes estaba sana.` : undefined,
    why: 'Sin caché cada turno paga todo el contexto a precio completo (leer de caché cuesta cerca del 10 %). Casi siempre lo provoca un cambio de modelo, herramientas o instrucciones.',
    action: 'Mirá «Ver cambios»: la sugerencia lista lo que se detectó (modelo, MCP, system prompt). Volvé a la configuración anterior si fue sin querer.',
    habit: 'Elegí modelo y herramientas al empezar; no los cambies en medio de una sesión larga.',
  },
  R4: {
    what: ({ view }) =>
      view ? `Tu último pedido no se parece a lo que venías trabajando, y la sesión arrastra ${approx(view)}${fmtTokens(view.contextSize)} tokens de esa otra tarea.` : undefined,
    why: 'Todo ese contexto se reenvía en cada mensaje de la tarea nueva: cuesta y distrae al modelo con información que no aplica.',
    action: 'Generá un traspaso y abrí una sesión nueva para la tarea nueva (en CLI, /clear o /new).',
    habit: 'Una tarea por sesión: al cambiar de tema, traspaso y sesión nueva.',
  },
  R5: {
    what: ({ suggestion, view }) =>
      suggestion ? `${suggestion.title}${view ? `; ahora el contexto es de ${approx(view)}${fmtTokens(view.contextSize)} tokens` : ''}.` : undefined,
    why: 'Esa salida quedó en el contexto y se va a reenviar en cada turno que siga.',
    action: 'Copiá la indicación y pegala: el agente va a leer por rangos, filtrar o delegar en un subagente.',
    habit: 'Pedí rangos o filtrá (grep/head) antes de volcar archivos o logs enteros.',
  },
  R6: {
    what: ({ suggestion }) => (suggestion ? `${suggestion.title}.` : undefined),
    why: 'Las definiciones de herramientas viajan en cada pedido aunque no las uses.',
    action: 'Mirá la lista y desactivá los servidores MCP que no necesitás para este trabajo.',
    habit: 'Activá los MCP por tipo de tarea, no todos siempre.',
  },
  R7: {
    what: ({ view }) => (view ? `Pedido corto con respuesta corta en ${view.model}, el modelo más caro.` : undefined),
    why: 'El modelo top cuesta varias veces más por token y para este tipo de pedido no rinde más.',
    action: 'Copiá el comando para cambiar a un modelo más chico.',
    habit: 'Empezá las tareas simples en un modelo más chico; cambiar en medio de una sesión grande invalida la caché.',
  },
  R8: {
    what: ({ suggestion, view }) =>
      view
        ? `El agente reintentó el mismo comando con los mismos argumentos y falló cada vez; cada intento reenvía ${approx(view)}${fmtTokens(view.contextSize)} tokens de contexto.`
        : suggestion
          ? `${suggestion.title}.`
          : undefined,
    why: 'Cada reintento reenvía todo el contexto sin avanzar: es lo que más cupo quema en poco tiempo.',
    action: 'Cortá el turno (Esc) o dale al agente el dato que le falta.',
    habit: 'Si ves el mismo error dos veces, intervení vos: el agente rara vez cambia de estrategia solo.',
  },
  R9: {
    what: ({ suggestion }) => (suggestion ? `${suggestion.title}: ese contenido ya estaba en la conversación.` : undefined),
    why: 'El bloque queda duplicado en el contexto y se reenvía dos veces en cada turno.',
    action: 'Copiá la indicación: pedile que use el archivo o bloque que ya tiene.',
    habit: 'Referenciá archivos por nombre en lugar de pegarlos otra vez.',
  },
  R10: {
    what: ({ suggestion }) => (suggestion ? `${suggestion.title}.` : undefined),
    why: 'Quedarte sin cupo a mitad de una tarea corta el trabajo en el peor momento.',
    action: 'Bajá el ritmo: modelo más chico, compactá las sesiones grandes y dejá lo pesado para después de la renovación.',
    habit: 'Mirá la barra de 5 h antes de arrancar una tarea larga.',
  },
  W1: {
    what: ({ view }) => (view ? `La conversación ya tiene ${view.turns} mensajes y ≈${fmtTokens(view.contextSize)} tokens.` : undefined),
    why: 'Cada mensaje reenvía toda la conversación y consume más de tu límite; en conversaciones largas el modelo además rinde peor.',
    action: 'Generá un resumen de traspaso y seguí en un chat nuevo.',
    habit: `Abrí un chat nuevo con resumen cuando pases ≈${fmtTokens(W1.defaults.tokens!)} tokens o cambies de tema.`,
  },
  W2: {
    what: ({ suggestion }) => (suggestion ? `${suggestion.title}.` : undefined),
    why: 'Cada subida vuelve a meter el archivo en el contexto.',
    action: 'Cargalo una vez en un Project (Claude), Project/GPT (ChatGPT) o Gem (Gemini).',
    habit: 'Los archivos de referencia que usás seguido van fijos en un Project o Gem.',
  },
  W3: {
    what: ({ suggestion }) => (suggestion ? `${suggestion.title}.` : undefined),
    why: 'Cada regeneración cuesta como un mensaje nuevo y rara vez cambia el resultado.',
    action: 'Copiá la plantilla y decí qué estuvo mal y qué esperás.',
    habit: 'Si la respuesta no sirve, reformulá con un ejemplo en lugar de regenerar.',
  },
  W4: {
    what: ({ suggestion }) => (suggestion ? `${suggestion.title}.` : undefined),
    why: 'Estos modos consumen bastante más de tu límite por mensaje.',
    action: 'Pasá al modo normal para este pedido.',
    habit: 'Reservá razonamiento extendido o investigación profunda para problemas que lo necesiten.',
  },
  G1: {
    what: ({ suggestion }) => (suggestion ? `${suggestion.title}.` : undefined),
    why: 'Por encima del tramo cada token del pedido cuesta más: el mismo trabajo sale más caro.',
    action: 'Comprimí ahora (/compress) antes de cruzar el tramo.',
    habit: 'En Gemini Pro mantené el prompt por debajo de 200k tokens.',
  },
  G2: {
    what: ({ view }) => (view ? `El contexto ya tiene ${approx(view)}${fmtTokens(view.contextSize)} tokens, aunque el porcentaje de la ventana parezca bajo.` : undefined),
    why: 'Con una ventana tan grande el porcentaje engaña: la latencia y el costo por turno crecen con el tamaño absoluto.',
    action: 'Comprimí (/compress) o abrí un chat nuevo con resumen.',
    habit: 'En Gemini mirá los tokens absolutos, no el porcentaje.',
  },
};

/**
 * CP-060: «Buena práctica» de una regla con los números de la sesión. Si la regla no tiene texto
 * propio, se usa el título y el detalle de la sugerencia.
 */
export function coachingFor(ruleId: string, ctx: CoachingContext = {}): Coaching {
  const c = COPY[ruleId];
  const now = ctx.now ?? Date.now();
  const what = c?.what?.({ ...ctx, now }) ?? (ctx.suggestion ? `${ctx.suggestion.title}.` : 'La regla detectó un patrón costoso en esta sesión.');
  return {
    what,
    why: c?.why ?? ctx.suggestion?.detail ?? '',
    action: c?.action ?? 'Usá las acciones de la sugerencia.',
    habit: c?.habit ?? '',
  };
}

// ---------------------------------------------------------------- consejos sin sugerencia

export type TipKind = 'cache-countdown' | 'cache-expired' | 'context-high' | 'context-rising' | 'cache-low' | 'model' | 'chat-long' | 'habit';

export interface Tip {
  kind: TipKind;
  text: string;
  /** Urgente: se muestra siempre (no rota). */
  urgent: boolean;
  /** Para la cuenta regresiva de caché: ms que faltan (≤ 0 = vencida). */
  remainingMs?: number;
}

/** Cada cuánto rota el consejo no urgente. */
export const TIP_ROTATE_MS = 30_000;
/** Contexto mínimo para hablar de la caché: el mismo que R2 (con menos, re-escribir es barato). */
const CACHE_TIP_MIN_TOKENS = R2.defaults.minTokens!;
const ACTIVE_MS = 30 * MIN;
/** TTL largo (1 h): la cuenta regresiva se muestra sólo cuando faltan ≤ 15 min. */
const COUNTDOWN_LONG_TTL_MS = 15 * MIN;

type TipView = Pick<SessionView, 'source' | 'provider' | 'model' | 'contextSize' | 'contextWindow' | 'contextPct' | 'cachePct' | 'turns' | 'lastTurnAt' | 'estimated'> &
  Partial<Pick<SessionView, 'cacheTtlMs'>>;

export interface TipOptions {
  /** Umbral de R1 configurado (default: el de la regla). */
  r1Pct?: number;
}

/** CP-060: cuenta regresiva de la caché; null si no aplica (fuente sin TTL real, contexto chico, estimado). */
export function cacheCountdown(v: TipView, now: number): { remainingMs: number; idleMs: number; ttlMs: number } | null {
  if (!(isCli(v.source) || v.source === 'proxy') || v.estimated || v.contextSize <= CACHE_TIP_MIN_TOKENS) return null;
  const last = Date.parse(v.lastTurnAt);
  if (!Number.isFinite(last)) return null;
  const ttlMs = v.cacheTtlMs || 5 * MIN;
  const idleMs = Math.max(0, now - last);
  return { remainingMs: ttlMs - idleMs, idleMs, ttlMs };
}

function minutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / MIN));
}

/** Todos los consejos aplicables al estado de la sesión, en orden de prioridad. */
export function tipsFor(v: TipView, now = Date.now(), opts: TipOptions = {}): Tip[] {
  const tips: Tip[] = [];
  const r1 = opts.r1Pct ?? R1.defaults.pct!;
  const chat = isChatUi(v.source);
  const compact = compactCommand(v.source);
  const clear = clearCommand(v.source);

  const cd = cacheCountdown(v, now);
  if (cd && cd.idleMs >= MIN) {
    // Con TTL de 1 h la cuenta regresiva recién aparece en los últimos 15 min (antes es ruido).
    if (cd.remainingMs > 0 && (cd.ttlMs <= 5 * MIN || cd.remainingMs <= COUNTDOWN_LONG_TTL_MS)) {
      tips.push({
        kind: 'cache-countdown',
        urgent: true,
        remainingMs: cd.remainingMs,
        text: `Caché expira en ${minutes(cd.remainingMs)} min (TTL ${ttlLabel(cd.ttlMs)}). Si seguís, escribí antes; si la pausa va a ser más larga, generá un traspaso ahora: retomar en frío re-escribe ≈${fmtTokens(v.contextSize)} tokens.`,
      });
    } else if (cd.idleMs < ACTIVE_MS) {
      tips.push({
        kind: 'cache-expired',
        urgent: true,
        remainingMs: cd.remainingMs,
        text: `La caché expiró hace ${minutes(-cd.remainingMs)} min: el próximo mensaje re-escribe ≈${fmtTokens(v.contextSize)} tokens. Si retomás otra cosa, mejor traspaso y sesión nueva${clear ? ` (${clear})` : ''}.`,
      });
    }
  }

  if (v.contextWindow && !chat) {
    const pct = fmtPct(v.contextPct);
    const how = compact ? `${compact} con foco («conservá X; resumí el resto»)` : 'recortar el historial';
    if (v.contextPct > r1) {
      tips.push({ kind: 'context-high', urgent: true, text: `Contexto al ${approx(v)}${pct}: conviene ${how} antes de que llegue la compactación automática.` });
    } else if (v.contextPct >= r1 * 0.75) {
      tips.push({
        kind: 'context-rising',
        urgent: false,
        text: `Contexto al ${approx(v)}${pct}. Cuando pase ${fmtPct(r1)} conviene ${how}: decile qué conservar (archivos, decisiones) y que resuma el resto.`,
      });
    }
  }

  if (v.cachePct !== null && v.cachePct < 0.5 && v.turns >= 3 && !v.estimated) {
    tips.push({
      kind: 'cache-low',
      urgent: false,
      text: `Sólo ${fmtPct(v.cachePct)} del contexto sale de caché. Evitá cambiar de modelo, herramientas/MCP o instrucciones a mitad de sesión: cada cambio invalida la caché.`,
    });
  }

  if (!chat && v.model && isTopTier(v.model, v.provider) && v.contextSize <= 30_000) {
    const small = smallerModelFor(v.provider);
    tips.push({
      kind: 'model',
      urgent: false,
      text: `Estás en ${v.model}. Para preguntas cortas o tareas mecánicas alcanza ${small}${isCli(v.source) ? ` (/model ${small})` : ''}; cambiá al empezar, no en medio de una sesión grande.`,
    });
  }

  if (chat) {
    const limit = W1.defaults.tokens!;
    if (v.contextSize > limit * 0.6 && v.contextSize <= limit) {
      tips.push({
        kind: 'chat-long',
        urgent: false,
        text: `La conversación tiene ≈${fmtTokens(v.contextSize)} tokens. Al pasar ≈${fmtTokens(limit)} (o al cambiar de tema) conviene un chat nuevo con resumen.`,
      });
    }
    tips.push({ kind: 'habit', urgent: false, text: 'Si usás el mismo archivo seguido, cargalo una vez en un Project o Gem en lugar de subirlo en cada chat.' });
  } else {
    tips.push({
      kind: 'habit',
      urgent: false,
      text: 'Para archivos y logs largos pedí rangos o filtrá (grep/head): todo lo que entra al contexto se reenvía en cada turno.',
    });
    tips.push({
      kind: 'habit',
      urgent: false,
      text: `Una tarea por sesión: al cambiar de tema, traspaso y ${clear ?? 'sesión nueva'}.`,
    });
  }
  return tips;
}

/**
 * CP-060: consejo a mostrar cuando la sesión no tiene sugerencia vigente. Lo urgente (caché por
 * vencer, contexto alto) gana siempre; si no, rota entre los aplicables cada TIP_ROTATE_MS.
 */
export function tipFor(v: TipView | undefined, now = Date.now(), opts: TipOptions = {}): string | null {
  if (!v || v.contextWindow <= 0) return null;
  const tips = tipsFor(v, now, opts);
  if (!tips.length) return null;
  const urgent = tips.find((t) => t.urgent);
  if (urgent) return urgent.text;
  return tips[Math.floor(now / TIP_ROTATE_MS) % tips.length]!.text;
}
