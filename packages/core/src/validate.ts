import type { Provider, Source, Suggestion, TurnEvent } from './types.js';
import { cleanTitle, projectFromCwd } from './names.js';
import { ulid } from './util.js';

// CP-004: validación de contratos canónicos en el borde (POST /ingest/events, parsers).
// Devuelve errores con el nombre del campo; completa id/ts si faltan. Sólo copia campos conocidos
// (lo desconocido se descarta para no persistir contenido inesperado).

export const SOURCES: readonly Source[] = ['claude-code', 'codex', 'gemini-cli', 'proxy', 'web', 'desktop'];
export const PROVIDERS: readonly Provider[] = ['anthropic', 'openai', 'google'];

export type ValidateResult<T> = { ok: true; event: T } | { ok: false; errors: string[] };

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isNonNeg = (x: unknown): x is number => isNum(x) && x >= 0;

export function validateTurnEvent(x: unknown, now = Date.now()): ValidateResult<TurnEvent> {
  const errors: string[] = [];
  if (!isObj(x)) return { ok: false, errors: ['event: no es un objeto'] };

  const req = (field: string, ok: boolean, why = 'requerido') => {
    if (!ok) errors.push(`${field}: ${why}`);
  };
  req('source', SOURCES.includes(x.source), `debe ser uno de ${SOURCES.join('|')}`);
  req('provider', PROVIDERS.includes(x.provider), `debe ser uno de ${PROVIDERS.join('|')}`);
  req('client', typeof x.client === 'string', 'string requerido');
  req('sessionId', typeof x.sessionId === 'string' && x.sessionId.length > 0, 'string no vacío requerido');
  req('turn', Number.isInteger(x.turn) && x.turn >= 0, 'entero ≥ 0 requerido');
  req('model', typeof x.model === 'string', 'string requerido');
  req('contextSize', isNonNeg(x.contextSize), 'número ≥ 0 requerido');
  req('contextWindow', isNonNeg(x.contextWindow), 'número ≥ 0 requerido');
  req('idleSincePrevMs', isNonNeg(x.idleSincePrevMs), 'número ≥ 0 requerido');
  req('promptHash', typeof x.promptHash === 'string', 'string requerido');
  if (x.id !== undefined) req('id', typeof x.id === 'string' && x.id.length > 0, 'string no vacío');
  if (x.ts !== undefined) req('ts', typeof x.ts === 'string' && !Number.isNaN(Date.parse(x.ts)), 'fecha ISO 8601');

  const t = x.tokens;
  if (!isObj(t)) errors.push('tokens: objeto requerido');
  else {
    req('tokens.input', isNonNeg(t.input), 'número ≥ 0 requerido');
    req('tokens.output', isNonNeg(t.output), 'número ≥ 0 requerido');
    req('tokens.estimated', typeof t.estimated === 'boolean', 'boolean requerido');
    for (const k of ['cacheRead', 'cacheWrite', 'reasoning'] as const) {
      if (t[k] !== undefined) req(`tokens.${k}`, isNonNeg(t[k]), 'número ≥ 0');
    }
  }

  // Opcionales con forma verificada.
  if (x.toolCalls !== undefined) {
    if (!Array.isArray(x.toolCalls)) errors.push('toolCalls: array');
    else
      x.toolCalls.forEach((tc: any, i: number) => {
        if (!isObj(tc) || typeof tc.name !== 'string' || !isNonNeg(tc.resultTokens) || typeof tc.failed !== 'boolean' || typeof tc.argsHash !== 'string')
          errors.push(`toolCalls[${i}]: {name, resultTokens, failed, argsHash}`);
      });
  }
  const hashList = (field: string) => {
    const v = x[field];
    if (v === undefined) return;
    if (!Array.isArray(v) || !v.every((a: any) => isObj(a) && typeof a.hash === 'string' && isNonNeg(a.tokens)))
      errors.push(`${field}: array de {hash, tokens}`);
  };
  hashList('attachments');
  hashList('blocks');
  if (x.toolsAvailable !== undefined) {
    if (!Array.isArray(x.toolsAvailable) || !x.toolsAvailable.every((a: any) => isObj(a) && typeof a.name === 'string' && isNonNeg(a.definitionTokens)))
      errors.push('toolsAvailable: array de {name, definitionTokens}');
  }
  if (x.promptEmbedding !== undefined && !(Array.isArray(x.promptEmbedding) && x.promptEmbedding.every(isNum)))
    errors.push('promptEmbedding: array de números');
  if (x.phase !== undefined && x.phase !== 'prompt' && x.phase !== 'response') errors.push('phase: prompt|response');
  if (x.windowSource !== undefined && !['table', 'default', 'observed'].includes(x.windowSource))
    errors.push('windowSource: table|default|observed');
  for (const k of ['regenerated', 'sidechain'] as const) {
    if (x[k] !== undefined && typeof x[k] !== 'boolean') errors.push(`${k}: boolean`);
  }
  for (const k of ['promptTokens', 'cacheTtlMs'] as const) {
    if (x[k] !== undefined && !isNonNeg(x[k])) errors.push(`${k}: número ≥ 0`);
  }
  if (x.expensiveMode !== undefined && typeof x.expensiveMode !== 'string') errors.push('expensiveMode: string');
  // CP-061: nombre de carpeta y título (cortos; el título no se persiste).
  for (const k of ['project', 'title'] as const) {
    if (x[k] !== undefined && (typeof x[k] !== 'string' || x[k].length > 500)) errors.push(`${k}: string (≤ 500)`);
  }
  if (x.promptContentWords !== undefined && !(Number.isInteger(x.promptContentWords) && x.promptContentWords >= 0))
    errors.push('promptContentWords: entero ≥ 0');

  if (errors.length) return { ok: false, errors };

  const tokens: TurnEvent['tokens'] = { input: t.input, output: t.output, estimated: t.estimated };
  if (t.cacheRead !== undefined) tokens.cacheRead = t.cacheRead;
  if (t.cacheWrite !== undefined) tokens.cacheWrite = t.cacheWrite;
  if (t.reasoning !== undefined) tokens.reasoning = t.reasoning;
  const event: TurnEvent = {
    id: x.id ?? ulid(now),
    source: x.source,
    provider: x.provider,
    client: x.client,
    sessionId: x.sessionId,
    turn: x.turn,
    ts: x.ts ? new Date(Date.parse(x.ts)).toISOString() : new Date(now).toISOString(),
    model: x.model,
    tokens,
    contextSize: x.contextSize,
    contextWindow: x.contextWindow,
    idleSincePrevMs: x.idleSincePrevMs,
    promptHash: x.promptHash,
  };
  const OPTIONAL = [
    'toolCalls',
    'promptEmbedding',
    'attachments',
    'regenerated',
    'phase',
    'promptTokens',
    'toolsAvailable',
    'cacheTtlMs',
    'expensiveMode',
    'blocks',
    'sidechain',
    'windowSource',
    'systemHash',
    'promptContentWords',
  ] as const;
  for (const k of OPTIONAL) if (x[k] !== undefined) (event as any)[k] = x[k];
  const project = projectFromCwd(x.project);
  if (project) event.project = project;
  const title = cleanTitle(x.title);
  if (title) event.title = title;
  return { ok: true, event };
}

/** CP-004.2: toda sugerencia tiene ≥ 1 acción de un clic. */
export function validateSuggestion(x: unknown): ValidateResult<Suggestion> {
  const errors: string[] = [];
  if (!isObj(x)) return { ok: false, errors: ['suggestion: no es un objeto'] };
  for (const k of ['id', 'ruleId', 'sessionId', 'title', 'detail', 'expiresAt'] as const) {
    if (typeof x[k] !== 'string' || !x[k]) errors.push(`${k}: string no vacío requerido`);
  }
  if (!['info', 'warn', 'critical'].includes(x.severity)) errors.push('severity: info|warn|critical');
  if (!Array.isArray(x.actions) || x.actions.length === 0) errors.push('actions: al menos una acción');
  else
    x.actions.forEach((a: any, i: number) => {
      if (!isObj(a) || !['copy', 'handoff', 'open-session', 'show-detail'].includes(a.kind) || typeof a.label !== 'string')
        errors.push(`actions[${i}]: {kind, label}`);
    });
  if (x.estimatedSavingTokens !== undefined && !isNonNeg(x.estimatedSavingTokens)) errors.push('estimatedSavingTokens: número ≥ 0');
  if (errors.length) return { ok: false, errors };
  return { ok: true, event: x as unknown as Suggestion };
}
