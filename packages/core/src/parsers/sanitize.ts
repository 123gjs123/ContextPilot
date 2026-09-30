// CP-003 / DECISIONS «verificabilidad»: sanitiza líneas de transcripts reales de Claude Code para
// usarlas como fixtures. Conserva estructura, usage, ids, timestamps, modelos y nombres de
// herramientas; todo otro string se reemplaza por un placeholder de IGUAL longitud (se conservan
// espacios/saltos de línea y las etiquetas propias de Claude Code como <command-name>, para no
// alterar la lógica del parser).
//
// Endurecido (D-7, verificado sobre transcripts reales por scripts/lib/snapshot.ts): además del
// contenido, reemplaza por placeholders de igual longitud
//  (a) CLAVES de objeto que no tienen forma de identificador (p. ej. `trackedFileBackups` indexado
//      por ruta `C:\Users\<usuario>\...`, `answers` indexado por el texto de la pregunta), y claves
//      que contengan términos de identidad;
//  (b) nombres de etiqueta `<...>` que no son de Claude Code (`<usuario>`, `<mi-proyecto>`);
//  (c) valores de claves de metadato (`type`, `id`, `name`...) que no tienen forma de id/enum o que
//      contienen identidad (p. ej. `type: "texto libre"` dentro del input de una herramienta), y
//      cualquier valor dentro de objetos libres (input de herramienta, toolUseResult, snapshot,
//      answers, structuredContent), donde las claves «de metadato» son contenido.
// Puro (sin node:os): los términos de identidad del sistema (usuario, host) los pasa quien llama.

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

/** Objetos libres: dentro, claves y valores son contenido (no se respeta KEEP_KEYS). */
export const FREE_KEYS = new Set(['input', 'toolUseResult', 'snapshot', 'answers', 'structuredContent']);

/** Etiquetas que genera Claude Code (estructura, no contenido del usuario). */
export const KNOWN_TAGS = new Set([
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'system-reminder',
  'task-notification',
  'task-id',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'user-prompt-submit-hook',
  'tool_use_error',
  'persisted-output',
  'environment_context',
  'user_instructions',
  'thinking',
  'status',
  'summary',
  'result',
  'usage',
]);

const TAG = /<(\/?)([a-z][a-z0-9_-]*)>/g;
/** Clave con forma de identificador (vocabulario del esquema). */
const ID_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,39}$/;
/** Valor de metadato aceptable: sin espacios, sin separadores de ruta, sin '@'. */
const SAFE_VALUE = /^[A-Za-z0-9_.:+\-\[\]<>]{0,120}$/;

export interface SanitizeOptions {
  /** Términos de identidad en minúsculas (se comparan por token completo). Ver identityTerms(). */
  identity?: ReadonlySet<string>;
  /** Contadores de lo que tuvo que corregir el endurecimiento (claves, etiquetas, valores). */
  stats?: { keys: number; tags: number; values: number };
}

/** Tokens alfanuméricos (≥ min) en minúsculas. Sin regex Unicode: cadenas de cientos de KB desbordan la pila. */
export function addTokens(s: string, into: Set<string>, min = 4): Set<string> {
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 32;
    const word =
      c < 128 ? (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 : s[i]!.toLowerCase() !== s[i]!.toUpperCase();
    if (word) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const cur = s.slice(start, i);
      if (cur.length >= min && cur.length <= 64) into.add(cur.toLowerCase());
      start = -1;
    }
  }
  return into;
}

function hasIdentity(s: string, identity: ReadonlySet<string> | undefined): boolean {
  if (!identity?.size) return false;
  for (const t of addTokens(s, new Set(), 3)) if (identity.has(t)) return true;
  return false;
}

/** Placeholder de igual longitud: todo no-espacio → 'x'; conserva etiquetas de Claude Code. */
export function placeholder(s: string, opts: SanitizeOptions = {}): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(TAG)) {
    const name = m[2]!;
    const keep = KNOWN_TAGS.has(name) && !opts.identity?.has(name);
    if (!keep && opts.stats) opts.stats.tags++;
    out += s.slice(last, m.index).replace(/\S/g, 'x') + (keep ? m[0] : `<${m[1]}${'x'.repeat(name.length)}>`);
    last = m.index! + m[0].length;
  }
  return out + s.slice(last).replace(/\S/g, 'x');
}

/** Placeholder de igual longitud para una clave, único dentro del objeto. */
function keyPlaceholder(k: string, used: Set<string>): string {
  const base = k.replace(/\S/g, 'x').replace(/\s/g, 'x') || 'x';
  if (!used.has(base)) return base;
  const abc = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; ; i++) {
    let suffix = '';
    let n = i;
    do {
      suffix = abc[n % 26] + suffix;
      n = Math.floor(n / 26);
    } while (n > 0);
    const cand = base.length > suffix.length ? base.slice(0, base.length - suffix.length) + suffix : 'x' + suffix;
    if (!used.has(cand)) return cand;
  }
}

function keepValue(v: string, key: string | undefined, parent: any, free: boolean, opts: SanitizeOptions): boolean {
  if (free || !key) return false;
  const meta = KEEP_KEYS.has(key) || (key === TOOL_NAME_KEY && parent?.type === 'tool_use');
  if (!meta) return false;
  if (SAFE_VALUE.test(v) && !hasIdentity(v, opts.identity)) return true;
  if (opts.stats) opts.stats.values++;
  return false;
}

function walk(v: unknown, key: string | undefined, parent: any, free: boolean, opts: SanitizeOptions): unknown {
  if (typeof v === 'string') return keepValue(v, key, parent, free, opts) ? v : placeholder(v, opts);
  if (Array.isArray(v)) return v.map((x) => walk(x, undefined, v, free, opts));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    const used = new Set<string>();
    for (const [k, x] of Object.entries(v)) {
      let nk = k;
      if (!ID_KEY.test(k) || hasIdentity(k, opts.identity)) {
        nk = keyPlaceholder(k, used);
        if (opts.stats) opts.stats.keys++;
      }
      used.add(nk);
      out[nk] = walk(x, k, v, free || FREE_KEYS.has(k), opts);
    }
    return out;
  }
  return v;
}

/** Sanitiza un registro ya parseado. */
export function sanitizeTranscriptRecord<T>(rec: T, opts: SanitizeOptions = {}): T {
  return walk(rec, undefined, undefined, false, opts) as T;
}

/**
 * Sanitiza una línea JSONL; líneas no JSON se reemplazan completas por placeholder.
 * `opts` es opcional (se ignora si no es un objeto: permite `lines.map(sanitizeTranscriptLine)`).
 */
export function sanitizeTranscriptLine(line: string, opts?: SanitizeOptions | number): string {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (!line.trim()) return line;
  try {
    return JSON.stringify(sanitizeTranscriptRecord(JSON.parse(line), o));
  } catch {
    return line.replace(/\S/g, 'x');
  }
}

// ---------- términos de identidad ----------

/**
 * Emails en s. Se busca sólo en ventanas alrededor de cada '@': la regex sobre cadenas enteras con
 * corridas largas de placeholder («xxxx…») es cuadrática.
 */
export function findEmails(s: string): string[] {
  const out: string[] = [];
  const RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g;
  for (let i = s.indexOf('@'); i >= 0; i = s.indexOf('@', i + 1)) {
    const win = s.slice(Math.max(0, i - 64), i + 256);
    for (const m of win.matchAll(RE)) out.push(m[0]);
  }
  return out;
}

const ENUM_KEYS = new Set(['type', 'role', 'subtype', 'level', 'userType', 'entrypoint', 'stop_reason', 'service_tier', 'speed', 'content_type', 'media_type', 'agentType', 'model']);
/** Segmentos genéricos de ruta/rama que no identifican a nadie. */
const GENERIC = new Set([
  'users', 'home', 'appdata', 'local', 'roaming', 'temp', 'tmp', 'program', 'files', 'windows', 'documents',
  'desktop', 'downloads', 'repos', 'src', 'dev', 'code', 'projects', 'claude', 'main', 'master', 'develop', 'head',
  'test', 'tests', 'api', 'app', 'apps', 'packages', 'scripts', 'docs', 'node_modules', 'onedrive',
]);

/**
 * Términos de identidad de un conjunto de registros: segmentos de `cwd`, ramas git y emails vistos,
 * más `system` (usuario y host del sistema, que el llamador obtiene con node:os). Se excluye el
 * vocabulario del esquema (claves con forma de identificador y valores enumerados), para no borrar
 * `type: "assistant"` porque el proyecto se llame «qa-lead-assistant».
 */
export function identityTerms(records: unknown[], system: string[] = []): Set<string> {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    if (!s) return;
    for (const t of addTokens(s, new Set(), 3)) if (!GENERIC.has(t)) out.add(t);
  };
  const schema = new Set<string>(KNOWN_TAGS);
  const visit = (v: unknown, key?: string, free = false) => {
    if (typeof v === 'string') {
      if (key === 'cwd' || key === 'gitBranch') add(v);
      if (!free && key && ENUM_KEYS.has(key) && SAFE_VALUE.test(v)) addTokens(v, schema, 3);
      for (const m of findEmails(v)) add(m);
      return;
    }
    if (Array.isArray(v)) v.forEach((x) => visit(x, undefined, free));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (!free && ID_KEY.test(k)) schema.add(k.toLowerCase());
        visit(x, k, free || FREE_KEYS.has(k) || k === 'attachment');
      }
  };
  records.forEach((r) => visit(r));
  for (const t of schema) out.delete(t);
  for (const x of system) add(x);
  return out;
}
