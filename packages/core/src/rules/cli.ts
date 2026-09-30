import { clearCommand, compactCommand, isCli, modelCommand } from '../actions.js';
import { isTopTier, smallerModelFor } from '../models.js';
import { promptTotal } from '../state.js';
import type { Rule, Source } from '../types.js';
import { fmtPct, fmtTokens, prettyToolName } from '../util.js';

const CLI: Source[] = ['claude-code', 'codex', 'gemini-cli'];
const CLI_API: Source[] = [...CLI, 'proxy'];
const ALL: Source[] = [...CLI_API, 'web', 'desktop'];
const MIN = 60_000;

export const R1: Rule = {
  id: 'R1',
  phase: 0,
  sources: CLI_API,
  requiresExact: false,
  defaults: { pct: 0.6 },
  defaultCooldownMs: 20 * MIN,
  on: ['response'],
  evaluate({ state, prev, event, thresholds }) {
    if (!state.contextWindow) return null;
    const pct = state.contextSize / state.contextWindow;
    if (pct <= thresholds.pct!) return null;
    // Histéresis: avisa al cruzar un escalón de 10 puntos (60, 70, 80, 90 %), no en cada turno.
    const band = (x: number) => Math.floor(x * 10);
    const prevPct = prev && prev.contextWindow ? prev.contextSize / prev.contextWindow : 0;
    if (prevPct > thresholds.pct! && band(prevPct) >= band(pct)) return null;
    // D-2: el foco (archivos/herramientas de los últimos 5 turnos) lo agrega el daemon al publicar,
    // leyendo el transcript en memoria: no se persiste (RNF-01). Aquí va el comando base.
    const cmd = compactCommand(event.source);
    return {
      // CP-010.1 / D-2: warn desde el umbral (CU-01 es el caso de uso principal).
      severity: 'warn',
      title: `Contexto al ${fmtPct(pct)}: compactá ahora`,
      detail: `La sesión usa ${fmtTokens(state.contextSize)} de ${fmtTokens(state.contextWindow)} tokens. Cada turno reenvía todo ese contexto; compactar con un foco lo reduce y evita la compactación automática en mal momento.`,
      estimatedSavingTokens: Math.round(state.contextSize * 0.7),
      actions: cmd
        ? [{ kind: 'copy', label: `Copiar ${cmd.split(' ')[0]}`, payload: cmd }, { kind: 'handoff', label: 'Generar foco sugerido' }]
        : [{ kind: 'show-detail', label: 'Recortar historial enviado' }],
    };
  },
};

export const R2: Rule = {
  id: 'R2',
  phase: 0,
  sources: CLI_API,
  requiresExact: true,
  defaults: { minTokens: 50_000 },
  defaultCooldownMs: 30 * MIN,
  on: ['prompt', 'response'],
  evaluate({ event, prev, state, thresholds }) {
    const ttl = state.cacheTtlMs;
    const idle = event.idleSincePrevMs;
    if (idle <= ttl) return null;
    const ttlLabel = ttl >= 60 * MIN ? '1 h' : `${Math.round(ttl / MIN)} min`;
    const clear = clearCommand(event.source);
    if ((event.phase ?? 'response') === 'prompt') {
      const ctx = prev?.contextSize ?? 0;
      if (ctx <= thresholds.minTokens!) return null;
      return {
        severity: 'warn',
        title: `Pausa de ${Math.round(idle / MIN)} min: la caché expiró`,
        detail: `El próximo turno vuelve a escribir ${fmtTokens(ctx)} tokens de contexto (TTL ${ttlLabel}). Empezar de cero con un resumen de traspaso cuesta una fracción.`,
        estimatedSavingTokens: Math.max(0, ctx - 4000),
        actions: [
          { kind: 'handoff', label: 'Generar traspaso' },
          ...(clear ? [{ kind: 'copy' as const, label: `Copiar ${clear}`, payload: clear }] : []),
        ],
      };
    }
    // D-18: una emisión por pausa. Si hubo evento 'prompt' (hooks/transcript), la pausa ya se evaluó
    // ahí (warn); la rama 'response' (info) queda para fuentes sin evento de prompt (proxy, Codex).
    if (prev?.lastPhase === 'prompt') return null;
    const rewritten = event.tokens.cacheWrite ?? 0;
    if (rewritten <= thresholds.minTokens!) return null;
    return {
      severity: 'info',
      title: `La caché expiró: se re-escribieron ${fmtTokens(rewritten)} tokens`,
      detail: `Pasaron ${Math.round(idle / MIN)} min (TTL ${ttlLabel}). La próxima vez que retomes tras una pausa larga con mucho contexto, conviene un traspaso a sesión nueva.`,
      actions: [{ kind: 'handoff', label: 'Generar traspaso ahora' }],
    };
  },
};

export const R3: Rule = {
  id: 'R3',
  phase: 1,
  sources: CLI_API,
  requiresExact: true,
  defaults: { ratio: 0.5, turns: 2, healthy: 0.7 },
  defaultCooldownMs: 30 * MIN,
  on: ['response'],
  evaluate({ state, prev, thresholds }) {
    const n = thresholds.turns!;
    const since = state.calls - n - 1;
    const r = state.cacheRatios;
    if (r.length < n + 1) return null;
    const recent = r.slice(-n);
    const before = r.slice(0, -n);
    if (!recent.every((x) => x < thresholds.ratio!)) return null;
    if (!before.some((x) => x >= thresholds.healthy!)) return null;
    const changes: string[] = [];
    // D-14: cambios ocurridos entre el último turno sano y ahora (no sólo en el último evento).
    if (prev && prev.lastModel !== state.lastModel) changes.push(`modelo ${prev.lastModel} → ${state.lastModel}`);
    else if (state.modelChangedAtCall !== undefined && state.modelChangedAtCall > since && state.modelBefore)
      changes.push(`modelo ${state.modelBefore} → ${state.lastModel}`);
    if (state.systemChangedAtCall !== undefined && state.systemChangedAtCall > since) changes.push('system prompt cambió (hash distinto)');
    const prevTools = new Set(prev?.toolsAvailable.map((t) => t.name) ?? []);
    const nowTools = new Set(state.toolsAvailable.map((t) => t.name));
    const added = [...nowTools].filter((t) => !prevTools.has(t));
    const removed = [...prevTools].filter((t) => !nowTools.has(t));
    if (added.length) changes.push(`herramientas agregadas: ${added.join(', ')}`);
    if (removed.length) changes.push(`herramientas quitadas: ${removed.join(', ')}`);
    return {
      severity: 'warn',
      title: `La caché cayó a ${fmtPct(recent.at(-1)!)}: algo la invalida`,
      detail: `En los últimos ${n} turnos casi nada salió de caché. Causas típicas: cambio de modelo, de herramientas/MCP o del system prompt. ${changes.length ? 'Detectado: ' + changes.join('; ') + '.' : 'No se detectó el cambio: revisá configuración reciente.'}`,
      actions: [{ kind: 'show-detail', label: 'Ver cambios' }],
    };
  },
};

export const R5: Rule = {
  id: 'R5',
  phase: 0,
  sources: CLI,
  requiresExact: false,
  defaults: { resultTokens: 10_000 },
  defaultCooldownMs: 10 * MIN,
  on: ['response'],
  evaluate({ event, thresholds }) {
    const big = (event.toolCalls ?? []).filter((t) => t.resultTokens > thresholds.resultTokens!);
    if (!big.length) return null;
    const top = big.reduce((a, b) => (b.resultTokens > a.resultTokens ? b : a));
    const ex = toolExample(top.name);
    return {
      severity: 'info',
      title: `${prettyToolName(top.name)} devolvió ${fmtTokens(top.resultTokens)} tokens`,
      detail: `Esa salida queda en el contexto para siempre. Ejemplo para ${prettyToolName(top.name)}: ${ex}`,
      estimatedSavingTokens: Math.round(top.resultTokens * 0.8),
      actions: [
        // CP-010.4 / D-14: ejemplo según la herramienta.
        { kind: 'show-detail', label: 'Ver ejemplo', payload: ex },
        { kind: 'copy', label: 'Copiar indicación', payload: 'Para archivos o salidas grandes, usá grep/head o leé por rangos; si hay que explorar mucho, delegá en un subagente y traé sólo la conclusión.' },
      ],
    };
  },
};

export const R6: Rule = {
  id: 'R6',
  phase: 1,
  // D-4: proxy = definiciones exactas (array tools del body); Claude Code = inventario estimado
  // (nombres diferidos + instrucciones MCP del transcript). Codex/Gemini CLI sin definiciones → no evalúa.
  sources: ['claude-code', 'proxy'],
  requiresExact: true,
  defaults: { idleTurns: 20 },
  // D-18: la lista de herramientas sin uso no cambia dentro de una sesión: a lo sumo una vez por día
  // y sesión (con 120 min el replay real dio hasta 15 disparos en una sesión).
  defaultCooldownMs: 24 * 60 * MIN,
  on: ['response'],
  evaluate({ state, thresholds }) {
    if (state.turns < thresholds.idleTurns!) return null;
    const unused = state.toolsAvailable.filter((t) => {
      const last = lastUse(state.toolLastUsedTurn, t.name);
      return last === undefined || state.turns - last >= thresholds.idleTurns!;
    });
    const cost = unused.reduce((s, t) => s + t.definitionTokens, 0);
    if (!unused.length || cost < 1000) return null;
    const names = unused.sort((a, b) => b.definitionTokens - a.definitionTokens).slice(0, 8);
    const est = unused.some((t) => t.estimated) ? '≈' : '';
    return {
      severity: 'info',
      title: `${unused.length} herramientas/MCP sin uso cuestan ${est}${fmtTokens(cost)} tokens por turno`,
      detail: `Sin uso en ${thresholds.idleTurns} turnos. Candidatas a desactivar: ${names.map((t) => `${prettyToolName(t.name)} (${t.estimated ? '≈' : ''}${fmtTokens(t.definitionTokens)})`).join(', ')}.${est ? ' Costo estimado: la fuente no expone las definiciones completas.' : ''}`,
      estimatedSavingTokens: cost,
      actions: [{ kind: 'show-detail', label: 'Ver lista' }],
    };
  },
};

export const R7: Rule = {
  id: 'R7',
  phase: 1,
  sources: CLI_API,
  requiresExact: false,
  defaults: { promptTokens: 200, outputTokens: 500, maxContext: 30_000 },
  defaultCooldownMs: 60 * MIN,
  on: ['response'],
  evaluate({ event, state, thresholds, modelTiers }) {
    // D-14: el nivel respeta los overrides de la config (`modelTiers`).
    if (!isTopTier(event.model, event.provider, modelTiers)) return null;
    // En sesiones grandes cambiar de modelo invalida la caché: el consejo sería contraproducente.
    if (state.contextSize > thresholds.maxContext!) return null;
    const p = event.promptTokens ?? state.lastPromptTokens;
    if (p === undefined || p >= thresholds.promptTokens!) return null;
    if (event.tokens.output >= thresholds.outputTokens!) return null;
    if ((event.toolCalls ?? []).length > 0) return null;
    const small = smallerModelFor(event.provider);
    const cmd = modelCommand(event.source, small);
    return {
      severity: 'info',
      title: 'Tarea simple en el modelo más caro',
      detail: `Prompt de ~${p} tokens y respuesta de ${event.tokens.output} en ${event.model}. Para este tipo de pedido alcanza un modelo más chico.`,
      actions: cmd ? [{ kind: 'copy', label: `Copiar ${cmd}`, payload: cmd }] : [{ kind: 'show-detail', label: `Usar ${small}` }],
    };
  },
};

export const R8: Rule = {
  id: 'R8',
  phase: 0,
  sources: CLI,
  requiresExact: false,
  defaults: { repeats: 3 },
  defaultCooldownMs: 5 * MIN,
  on: ['response'],
  evaluate({ state, thresholds }) {
    const n = thresholds.repeats!;
    const last = state.recentToolCalls.slice(-n);
    if (last.length < n) return null;
    const first = last[0]!;
    if (!last.every((t) => t.failed && t.argsHash === first.argsHash && t.name === first.name)) return null;
    // CP-012.1 / D-13: comando (herramienta + huella de argumentos, sin contenido) y timestamps.
    const times = last.map((t) => (t.ts ? t.ts.slice(11, 19) : '?')).join(', ');
    return {
      severity: 'critical',
      title: `Agente en loop: ${prettyToolName(first.name)} falló ${n} veces igual`,
      detail: `Comando: ${prettyToolName(first.name)} (args #${first.argsHash.slice(0, 8) || '—'}), fallos a las ${times} UTC. El agente repite el mismo comando con los mismos argumentos y sigue fallando. Intervení con más contexto o cortá el turno; cada reintento reenvía todo el contexto.`,
      estimatedSavingTokens: state.contextSize,
      actions: [{ kind: 'show-detail', label: 'Ver la sesión' }],
    };
  },
};

export const R9: Rule = {
  id: 'R9',
  phase: 1,
  sources: ALL,
  requiresExact: false,
  defaults: { repeats: 2, tokens: 2000 },
  defaultCooldownMs: 30 * MIN,
  on: ['prompt', 'response'],
  evaluate({ event, state, thresholds }) {
    const hits = (event.blocks ?? []).filter((b) => {
      const c = state.blockCounts[b.hash];
      return c && c.count >= thresholds.repeats! && b.tokens > thresholds.tokens!;
    });
    if (!hits.length) return null;
    const tokens = hits.reduce((s, b) => s + b.tokens, 0);
    return {
      severity: 'info',
      title: `Pegaste de nuevo un bloque de ${fmtTokens(tokens)} tokens`,
      detail: 'El mismo contenido ya está en la conversación. Referencialo como archivo o por nombre en lugar de pegarlo otra vez.',
      estimatedSavingTokens: tokens,
      actions: isCli(event.source)
        ? [{ kind: 'copy', label: 'Copiar indicación', payload: 'Usá el archivo/bloque que ya te pasé antes; no lo repito.' }]
        : [{ kind: 'show-detail', label: 'Cómo referenciarlo' }],
    };
  },
};


/** R6: última vez que se usó una herramienta o, si es un servidor MCP (`mcp__srv`), cualquiera de las suyas. */
function lastUse(used: Record<string, number>, name: string): number | undefined {
  let last = used[name];
  if (name.startsWith('mcp__') && name.split('__').length === 2) {
    const prefix = name + '__';
    for (const [k, v] of Object.entries(used)) if (k.startsWith(prefix) && (last === undefined || v > last)) last = v;
  }
  return last;
}

/** R5: ejemplo concreto según la herramienta que devolvió la salida grande. */
export function toolExample(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith('mcp__')) return 'delegá la consulta a un subagente que devuelva sólo la conclusión, o pedí menos campos/resultados.';
  if (n === 'read' || n.includes('read_file') || n === 'view') return 'leé por rangos (Read con offset/limit) o buscá primero con Grep la sección que necesitás.';
  if (n === 'bash' || n === 'shell' || n === 'powershell' || n.includes('exec') || n.includes('command'))
    return 'filtrá la salida: `cmd | head -50`, `cmd | grep -n patrón` o `cmd | tail -20`.';
  if (n === 'grep' || n === 'glob' || n.includes('search')) return 'acotá la búsqueda: sólo nombres de archivo (-l), un glob más estrecho o un límite de resultados (head_limit).';
  if (n.includes('fetch') || n.includes('web')) return 'pedí sólo el fragmento o un resumen de la página, no el documento entero.';
  return 'delegá en un subagente que devuelva sólo la conclusión, o pedí un subconjunto (head/grep/rangos).';
}
