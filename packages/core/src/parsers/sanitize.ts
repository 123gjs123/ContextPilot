// CP-003 / DECISIONS «verificabilidad»: sanitiza líneas de transcripts reales de Claude Code para
// usarlas como fixtures. Conserva estructura, usage, ids, timestamps, modelos y nombres de
// herramientas; todo otro string se reemplaza por un placeholder de IGUAL longitud (se conservan
// espacios/saltos de línea y etiquetas tipo <command-name> para no alterar la lógica del parser).

/** Claves cuyo valor string es metadato, no contenido. */
const KEEP_KEYS = new Set([
  'type',
  'role',
  'id',
  'uuid',
  'parentUuid',
  'leafUuid',
  'logicalParentUuid',
  'sessionId',
  'agentId',
  'promptId',
  'requestId',
  'messageId',
  'tool_use_id',
  'toolUseId',
  'timestamp',
  'model',
  'version',
  'stop_reason',
  'userType',
  'entrypoint',
  'service_tier',
  'speed',
  'inference_geo',
  'subtype',
  'level',
  'content_type',
  'media_type',
  'agentType',
]);

/** Claves cuyo valor se conserva sólo si va dentro de un bloque tool_use (nombre de herramienta). */
const TOOL_NAME_KEY = 'name';

const TAG = /<\/?[a-z][a-z0-9_-]*>/g;

export function placeholder(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(TAG)) {
    out += s.slice(last, m.index).replace(/\S/g, 'x') + m[0];
    last = m.index! + m[0].length;
  }
  return out + s.slice(last).replace(/\S/g, 'x');
}

function walk(v: unknown, key: string | undefined, parent: any): unknown {
  if (typeof v === 'string') {
    if (key && KEEP_KEYS.has(key)) return v;
    if (key === TOOL_NAME_KEY && parent?.type === 'tool_use') return v;
    return placeholder(v);
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, undefined, v));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, k, v);
    return out;
  }
  return v;
}

/** Sanitiza un registro ya parseado. */
export function sanitizeTranscriptRecord<T>(rec: T): T {
  return walk(rec, undefined, undefined) as T;
}

/** Sanitiza una línea JSONL; líneas no JSON se reemplazan completas por placeholder. */
export function sanitizeTranscriptLine(line: string): string {
  if (!line.trim()) return line;
  try {
    return JSON.stringify(sanitizeTranscriptRecord(JSON.parse(line)));
  } catch {
    return placeholder(line);
  }
}
