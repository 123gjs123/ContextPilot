import { ALL_RULES } from './engine.js';
import type { Rule, RuleThresholds, Source } from './types.js';

// CP-063: documentación de cada regla en lenguaje llano (pestaña Configuración del dashboard; la
// extensión puede reusarla). Puro. Los valores recomendados salen de las propias reglas
// (`defaults` / `defaultCooldownMs`): el texto explica el porqué, nunca repite cifras a mano.

export interface ThresholdDoc {
  key: string;
  /** Nombre legible del umbral. */
  label: string;
  /** Valor recomendado (= default de la regla). */
  value: number;
  /** Valor formateado para mostrar («60 %», «50k tokens», «20 turnos»). */
  valueText: string;
  /** Por qué ese valor. */
  why: string;
}

export interface RuleDoc {
  id: string;
  /** Nombre corto de la regla. */
  name: string;
  /** Qué detecta (cómo funciona el código, en llano). */
  detects: string;
  /** Por qué importa. */
  why: string;
  /** Qué sugiere hacer. */
  suggests: string;
  /** Dónde se evalúa. */
  sourcesText: string;
  /** true = sólo con cifras exactas (no estimadas). */
  requiresExact: boolean;
  /** Señal de cuenta (R10) en lugar de sesión. */
  account: boolean;
  thresholds: ThresholdDoc[];
  cooldownMin: number;
  cooldownWhy: string;
}

type Fmt = 'pct' | 'tokens' | 'count' | 'ratio' | 'min' | 'factor';

interface ThresholdCopy {
  label: string;
  fmt: Fmt;
  unit?: string;
  why: string;
}

interface RuleCopy {
  name: string;
  detects: string;
  why: string;
  suggests: string;
  thresholds: Record<string, ThresholdCopy>;
  cooldownWhy: string;
}

const SOURCE_LABEL: Record<Source, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
  proxy: 'proxy local',
  web: 'web (extensión)',
  desktop: 'Claude Desktop',
};

const COPY: Record<string, RuleCopy> = {
  R1: {
    name: 'Contexto alto',
    detects:
      'La ocupación del contexto (tokens en contexto ÷ ventana del modelo) superó el umbral. Avisa al cruzar cada escalón de 10 puntos (60, 70, 80, 90 %), no en cada turno.',
    why: 'Cada turno reenvía todo el contexto: cuanto más lleno, más caro cada mensaje y más cerca de la compactación automática, que llega en el peor momento y resume sin saber qué te importa.',
    suggests: 'Compactar ahora con foco: en Claude Code, /compact con los archivos y herramientas de los últimos 5 prompts; en Codex /compact; en Gemini CLI /compress. En el proxy, recortar el historial enviado.',
    thresholds: {
      pct: { label: 'Umbral de ocupación', fmt: 'pct', why: 'Con 60 % todavía hay margen para compactar a mano con un buen resumen, lejos de la compactación automática (cerca del límite).' },
    },
    cooldownWhy: 'Da tiempo a compactar. Además la regla sólo vuelve a avisar al cruzar otro escalón de 10 puntos.',
  },
  R2: {
    name: 'Pausa más larga que la caché',
    detects:
      'La pausa desde la última respuesta superó el TTL real de la caché de la sesión (5 min o 1 h, leído de los datos de caché de cada llamada) con mucho contexto. Se evalúa sola al vencer el TTL (antes de que vuelvas a escribir) y al volver a escribir.',
    why: 'Cuando la caché expira, el próximo mensaje vuelve a escribir todo el contexto en caché, a precio más alto que leerlo. Con contexto grande, retomar «en frío» cuesta mucho más que empezar de cero con un resumen.',
    suggests: 'Si la pausa va a ser larga o cambiás de tarea: generar un traspaso y abrir sesión nueva (/clear en Claude Code y Gemini CLI, /new en Codex).',
    thresholds: {
      minTokens: { label: 'Contexto mínimo', fmt: 'tokens', why: 'Con menos de 50k tokens re-escribir la caché es barato: no vale la interrupción.' },
    },
    cooldownWhy: 'Una emisión por pausa: el temporizador y el prompt que cierra la pausa no repiten el aviso.',
  },
  R3: {
    name: 'Caché rota',
    detects:
      'En los últimos turnos casi nada salió de caché (proporción baja) después de haber estado sana. Lista lo que detectó que cambió: modelo, herramientas/MCP o system prompt.',
    why: 'Sin caché, cada turno paga todo el contexto a precio completo (leer de caché cuesta cerca del 10 %). Suele pasar por un cambio de configuración a mitad de sesión.',
    suggests: 'Revisar qué cambió y evitar cambiar modelo, herramientas o instrucciones en medio de una sesión larga.',
    thresholds: {
      ratio: { label: 'Caché «baja» por debajo de', fmt: 'pct', why: 'Menos de la mitad del prompt desde caché ya duplica el costo por turno.' },
      turns: { label: 'Turnos seguidos con caché baja', fmt: 'count', unit: 'turnos', why: 'Dos seguidos descartan un turno aislado (p. ej. el primero tras una herramienta grande).' },
      healthy: { label: 'Caché «sana» desde', fmt: 'pct', why: 'Sólo avisa si antes la caché funcionaba (≥ 70 %): así detecta una rotura, no una sesión que nunca cacheó.' },
    },
    cooldownWhy: 'Da tiempo a revisar la configuración sin repetir el aviso en cada turno.',
  },
  R4: {
    name: 'Tarea nueva en sesión vieja',
    detects:
      'El prompt nuevo es temáticamente distinto (similitud de un embedding local, sin enviar nada afuera) del promedio de los prompts anteriores Y de cada uno de los últimos 3. No evalúa preguntas cortas ni sesiones chicas.',
    why: 'Arrastrar decenas de miles de tokens de otra tarea cuesta en cada turno y distrae al modelo con contexto que no aplica.',
    suggests: 'Generar un traspaso y abrir sesión nueva (en CLI, /clear o /new).',
    thresholds: {
      cosine: { label: 'Similitud máxima para «tarea nueva»', fmt: 'ratio', why: 'Calibrado sobre 100 casos etiquetados: con < 0,30 la precisión supera el 80 % (pocos falsos avisos).' },
      minPrompts: { label: 'Prompts previos mínimos', fmt: 'count', unit: 'prompts', why: 'Con menos prompts todavía no hay «tema» de la sesión con qué comparar.' },
      minContext: { label: 'Contexto mínimo', fmt: 'tokens', why: 'Con poco contexto seguir en la misma sesión es barato.' },
      minPromptTokens: { label: 'Largo mínimo del prompt', fmt: 'tokens', why: 'Los prompts muy cortos no tienen señal temática suficiente.' },
      minContentWords: { label: 'Palabras con contenido mínimas', fmt: 'count', unit: 'palabras', why: 'Una pregunta corta («¿qué es esto?») suele ser un seguimiento, no una tarea nueva.' },
    },
    cooldownWhy: 'Si decidiste seguir en la misma sesión, no insiste en cada prompt.',
  },
  R5: {
    name: 'Salida de herramienta enorme',
    detects: 'Una herramienta devolvió un resultado de muchos tokens (lectura de archivo, comando, búsqueda, MCP).',
    why: 'Esa salida queda en el contexto para siempre y se reenvía en cada turno siguiente.',
    suggests: 'Un ejemplo según la herramienta: leer por rangos, filtrar con grep/head/tail, acotar la búsqueda o delegar en un subagente que traiga sólo la conclusión.',
    thresholds: {
      resultTokens: { label: 'Tamaño de salida', fmt: 'tokens', why: '10k tokens ya es el 5 % de una ventana de 200k en una sola salida.' },
    },
    cooldownWhy: 'Corto: cada salida grande es un caso nuevo, pero sin avisar varias veces en la misma ráfaga.',
  },
  R6: {
    name: 'Herramientas/MCP sin uso',
    detects:
      'Servidores MCP o herramientas disponibles que no se usaron en muchos turnos y cuyas definiciones suman al menos 1k tokens por turno. En Claude Code el costo es estimado (≈); en el proxy, exacto.',
    why: 'Las definiciones de herramientas viajan en cada pedido aunque no se usen.',
    suggests: 'Desactivar esos servidores MCP para este tipo de trabajo.',
    thresholds: {
      idleTurns: { label: 'Turnos sin uso', fmt: 'count', unit: 'turnos', why: 'Veinte turnos sin tocarla es señal clara de que sobra en esta sesión.' },
    },
    cooldownWhy: 'La lista no cambia dentro de una sesión: a lo sumo una vez por día y sesión.',
  },
  R11: {
    name: 'MCP desactivado que hace falta',
    detects:
      'Un prompt de Claude Code menciona un servidor MCP que desactivaste desde ContextPilot en ese proyecto (por su nombre o palabras asociadas, como «Jira» para Atlassian). El texto del prompt no se guarda.',
    why: 'Sin el servidor, el agente no puede usar esas herramientas y termina adivinando o pidiéndote datos a mano.',
    suggests: 'Reactivar el servidor con un botón, desde la misma tarjeta.',
    thresholds: {},
    cooldownWhy: 'Corto: si seguís pidiendo cosas de ese servidor, vuelve a avisar, pero no en cada prompt.',
  },
  R7: {
    name: 'Tarea simple en el modelo más caro',
    detects:
      'Pedido corto con respuesta corta y sin herramientas en un modelo de nivel «top» (p. ej. Opus), en una sesión todavía chica.',
    why: 'El modelo top cuesta varias veces más por token y para este tipo de pedido no rinde más.',
    suggests: 'Cambiar a un modelo más chico (/model sonnet o equivalente) al empezar este tipo de tareas.',
    thresholds: {
      promptTokens: { label: 'Prompt corto hasta', fmt: 'tokens', why: 'Un prompt de menos de 200 tokens suele ser una pregunta puntual.' },
      outputTokens: { label: 'Respuesta corta hasta', fmt: 'tokens', why: 'Si la respuesta también es corta, el trabajo fue simple.' },
      maxContext: { label: 'Contexto máximo', fmt: 'tokens', why: 'En sesiones grandes cambiar de modelo invalida la caché: el consejo sería contraproducente.' },
    },
    cooldownWhy: 'Es un consejo de hábito: una vez por hora alcanza.',
  },
  R8: {
    name: 'Agente en loop',
    detects: 'Las últimas llamadas a herramientas fallaron todas con la misma herramienta y los mismos argumentos (misma huella).',
    why: 'Cada reintento reenvía todo el contexto sin avanzar: es el patrón que más cupo quema en poco tiempo.',
    suggests: 'Intervenir: cortar el turno o darle al agente el dato que le falta.',
    thresholds: {
      repeats: { label: 'Fallos idénticos seguidos', fmt: 'count', unit: 'fallos', why: 'Tres fallos iguales ya no son mala suerte: el agente no va a cambiar de estrategia solo.' },
    },
    cooldownWhy: 'Corto (es crítica): si el loop sigue, vuelve a avisar pronto.',
  },
  R9: {
    name: 'Bloque pegado de nuevo',
    detects: 'Pegaste otra vez un bloque grande (código, log, documento) que ya estaba en la conversación.',
    why: 'El contenido queda dos veces en el contexto y se reenvía duplicado en cada turno.',
    suggests: 'Referenciarlo por archivo o por nombre («el log que te pasé antes»).',
    thresholds: {
      repeats: { label: 'Veces pegado', fmt: 'count', unit: 'veces', why: 'A la segunda ya está duplicado.' },
      tokens: { label: 'Tamaño mínimo del bloque', fmt: 'tokens', why: 'Repetir fragmentos chicos es normal y barato.' },
    },
    cooldownWhy: 'Evita repetir el aviso si pegás varios bloques seguidos.',
  },
  R10: {
    name: 'Límite del plan',
    detects:
      'Señal de cuenta (no de sesión): con un perfil de plan (o el uso del plan que informa Claude Desktop), proyecta el ritmo reciente sobre cada ventana (5 h, 7 días) y avisa si se agota antes de renovarse. En planes API, si el gasto diario proyectado supera el presupuesto.',
    why: 'Quedarte sin cupo a mitad de una tarea es lo más caro de todo: cortás el trabajo en el peor momento.',
    suggests: 'Bajar el ritmo: modelo más chico, compactar, dejar tareas pesadas para después de la renovación.',
    thresholds: {
      rateWindowMin: { label: 'Ventana del ritmo', fmt: 'min', why: 'El ritmo de la última hora predijo mejor que el de 30 min en datos reales de uso.' },
      minPoints: { label: 'Puntos mínimos', fmt: 'count', unit: 'puntos', why: 'Con menos datos el ritmo es ruido.' },
      rateDamping: { label: 'Amortiguación del ritmo', fmt: 'factor', why: 'El uso es a ráfagas: proyectar con ×0,6 del ritmo reciente dio el menor error sin perder agotamientos reales.' },
    },
    cooldownWhy: 'Mientras la proyección se cumpla el aviso se renueva (mismo aviso, no uno nuevo); si deja de cumplirse, se retira.',
  },
  W1: {
    name: 'Conversación web larga',
    detects: 'La conversación en el sitio (claude.ai, ChatGPT, Gemini) o en Claude Desktop superó un tamaño estimado o una cantidad de mensajes.',
    why: 'Cada mensaje reenvía toda la conversación y consume más de tu límite; además el modelo rinde peor con conversaciones muy largas.',
    suggests: 'Abrir un chat nuevo con un resumen de traspaso.',
    thresholds: {
      tokens: { label: 'Tamaño estimado', fmt: 'tokens', why: 'Alrededor de 80k tokens cada mensaje ya reenvía mucho más de lo que agrega.' },
      turns: { label: 'Mensajes', fmt: 'count', unit: 'mensajes', why: 'Con 40 mensajes la conversación suele mezclar temas.' },
    },
    cooldownWhy: 'No insiste en cada mensaje si decidiste seguir.',
  },
  W2: {
    name: 'Mismo archivo subido otra vez',
    detects: 'Subiste el mismo adjunto (misma huella) varias veces, en esta conversación o en el mismo sitio en los últimos 7 días.',
    why: 'Cada subida lo vuelve a meter en el contexto.',
    suggests: 'Cargarlo una vez en un Project (Claude), Project/GPT (ChatGPT) o Gem (Gemini).',
    thresholds: {
      repeats: { label: 'Subidas', fmt: 'count', unit: 'veces', why: 'A la segunda ya conviene dejarlo fijo.' },
    },
    cooldownWhy: 'Es un consejo de hábito: una vez por hora alcanza.',
  },
  W3: {
    name: 'Regenerar sin cambiar el pedido',
    detects: 'Regeneraste varias veces seguidas la misma respuesta.',
    why: 'Cada regeneración cuesta como un mensaje nuevo y rara vez cambia el resultado.',
    suggests: 'Reformular: decir qué estuvo mal y dar un ejemplo del resultado esperado.',
    thresholds: {
      regenerations: { label: 'Regeneraciones seguidas', fmt: 'count', unit: 'veces', why: 'A la tercera, insistir ya no es la estrategia.' },
    },
    cooldownWhy: 'Evita repetir el aviso en la misma racha.',
  },
  W4: {
    name: 'Modo caro para una pregunta simple',
    detects: 'Un modo caro (razonamiento extendido, investigación profunda) activo para un pedido corto.',
    why: 'Estos modos consumen bastante más de tu límite por mensaje.',
    suggests: 'Usar el modo normal para pedidos cortos.',
    thresholds: {
      promptTokens: { label: 'Pedido corto hasta', fmt: 'tokens', why: 'Menos de 200 tokens suele ser una pregunta puntual.' },
    },
    cooldownWhy: 'Es un consejo de hábito: una vez por hora alcanza.',
  },
  G1: {
    name: 'Tramo de precio de Gemini',
    detects: 'En Gemini (CLI o proxy), el prompt está cerca de cruzar (o cruzó) el tramo de precio por tamaño (200k tokens en Gemini Pro).',
    why: 'Por encima del tramo cada token del pedido cuesta más: el mismo trabajo sale más caro.',
    suggests: 'Comprimir (/compress en Gemini CLI) antes de cruzar el tramo.',
    thresholds: {
      margin: { label: 'Margen antes del tramo', fmt: 'pct', why: 'Avisar al 90 % del tramo deja tiempo para comprimir antes de cruzarlo.' },
    },
    cooldownWhy: 'Evita repetir el aviso mientras el contexto oscila cerca del tramo.',
  },
  G2: {
    name: 'Contexto absoluto enorme (Gemini)',
    detects: 'En Gemini el contexto superó un tamaño absoluto, aunque el porcentaje de la ventana (1M) parezca bajo.',
    why: 'Con una ventana tan grande el porcentaje engaña: la latencia y el costo por turno crecen con el tamaño absoluto.',
    suggests: 'Comprimir (/compress) o abrir un chat nuevo con resumen.',
    thresholds: {
      tokens: { label: 'Contexto absoluto', fmt: 'tokens', why: '200k tokens es donde además sube el precio por token en Gemini Pro.' },
    },
    cooldownWhy: 'Da tiempo a comprimir sin repetir el aviso en cada turno.',
  },
};

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Valor legible de un umbral según su tipo. */
export function formatThreshold(value: number, fmt: Fmt, unit?: string): string {
  switch (fmt) {
    case 'pct':
      return `${Math.round(value * 100)} %`;
    case 'tokens':
      return `${fmtK(value)} tokens`;
    case 'ratio':
    case 'factor':
      return `${fmt === 'factor' ? '×' : ''}${String(value).replace('.', ',')}`;
    case 'min':
      return `${value} min`;
    default:
      return unit ? `${value} ${unit}` : String(value);
  }
}

function sourcesText(r: Rule): string {
  if (r.sources.length >= 6) return 'todas las fuentes';
  return r.sources.map((s) => SOURCE_LABEL[s]).join(', ');
}

/** Documento de una regla, con los valores recomendados tomados de la propia regla. */
export function ruleDoc(rule: Rule): RuleDoc {
  const c = COPY[rule.id];
  const thresholds: ThresholdDoc[] = Object.entries(rule.defaults).map(([key, value]) => {
    const t = c?.thresholds[key];
    return {
      key,
      label: t?.label ?? key,
      value,
      valueText: t ? formatThreshold(value, t.fmt, t.unit) : String(value),
      why: t?.why ?? '',
    };
  });
  return {
    id: rule.id,
    name: c?.name ?? rule.id,
    detects: c?.detects ?? '',
    why: c?.why ?? '',
    suggests: c?.suggests ?? '',
    sourcesText: sourcesText(rule),
    requiresExact: rule.requiresExact,
    account: rule.scope === 'account',
    thresholds,
    cooldownMin: Math.round(rule.defaultCooldownMs / 60_000),
    cooldownWhy: c?.cooldownWhy ?? '',
  };
}

/** Documentos de todas las reglas (orden R, W, G). */
export function ruleDocs(rules: Rule[] = ALL_RULES): RuleDoc[] {
  return rules.map(ruleDoc);
}

/** Documento por id (undefined si la regla no existe). */
export function ruleDocFor(id: string, rules: Rule[] = ALL_RULES): RuleDoc | undefined {
  const r = rules.find((x) => x.id === id);
  return r ? ruleDoc(r) : undefined;
}

/** Nombre corto de una regla para UIs («R1 · Contexto alto»). */
export function ruleName(id: string): string {
  return COPY[id]?.name ?? id;
}

/** Etiqueta legible de un umbral de una regla (para formularios). */
export function thresholdLabel(ruleId: string, key: string): string {
  return COPY[ruleId]?.thresholds[key]?.label ?? key;
}

/** Valores recomendados de una regla (para «Restaurar recomendado»). */
export function recommendedSettings(id: string, rules: Rule[] = ALL_RULES): { thresholds: RuleThresholds; cooldownMin: number } | undefined {
  const r = rules.find((x) => x.id === id);
  return r ? { thresholds: { ...r.defaults }, cooldownMin: Math.round(r.defaultCooldownMs / 60_000) } : undefined;
}

/** CP-063: textos breves de perfiles de plan y adaptadores para la pestaña Configuración. */
export const PLAN_DOCS = {
  intro:
    'El perfil de plan le dice a ContextPilot cuánto cupo tenés, para proyectar a qué hora te quedarías sin él (regla R10). Sin perfil, R10 no se evalúa.',
  subscription:
    'Suscripción (Claude Pro/Max, ChatGPT Plus, Gemini): límite por ventana de horas. Los proveedores no publican cifras exactas: los presets son un punto de partida «a calibrar». Si Claude Desktop está instalado, su uso del plan (5 h y 7 días, en %) reemplaza al perfil de Anthropic automáticamente.',
  api: 'API (pago por uso): presupuesto diario en USD y precio por millón de tokens; R10 avisa si el gasto proyectado del día supera el presupuesto.',
};

export const ADAPTER_DOCS: Record<string, string> = {
  'claude-code': 'Lee los transcripts de Claude Code (~/.claude/projects) en sólo lectura.',
  codex: 'Lee las sesiones de Codex CLI (~/.codex/sessions) en sólo lectura.',
  'gemini-cli': 'Lee la telemetría local de Gemini CLI (archivo outfile u OTLP local).',
  hooks: 'Recibe los hooks de Claude Code (acelera la detección; el transcript sigue siendo la fuente).',
  proxy: 'Proxy local opcional para SDKs/API: cifras exactas y definiciones de herramientas.',
  web: 'Eventos de la extensión del navegador (claude.ai, ChatGPT, Gemini): cifras estimadas (≈).',
  desktop: 'Eventos de Claude Desktop (captura CDP): cifras estimadas (≈).',
  'claude-plan-usage': 'Uso del plan de Claude que informa Claude Desktop (5 h y 7 días, sólo lectura).',
};
