// CP-003.1 / D-7: lógica de snapshot-fixtures (sanitizar transcripts reales de Claude Code).
//
// Capa 1: sanitizeTranscriptLine() del core (placeholders de igual longitud, conserva metadatos).
// Capa 2 (harden, acá): el core deja pasar texto de contenido en tres lugares, verificado sobre
//   transcripts reales: (a) CLAVES de objetos libres (p. ej. `trackedFileBackups` indexado por ruta,
//   `answers` indexado por el texto de la pregunta), (b) nombres de etiquetas `<...>` escritas por
//   el usuario/modelo (`<usuario>`, `<nombre-de-proyecto>`), y (c) valores de claves "de metadato"
//   (`type`, `id`, `name`, ...) que aparecen dentro de inputs libres de herramientas. Esta capa los
//   reemplaza por placeholders de igual longitud, sin tocar lo que lee el parser.
// Verificación: conjunto de tokens del contenido original ∩ tokens del resultado, términos de
//   identidad (usuario, host, segmentos de `cwd`, ramas git, emails) y patrones de ruta/email.
import { hostname, userInfo } from 'node:os';
import { ClaudeCodeParser, placeholder, sanitizeTranscriptLine, type TurnEvent } from '../../packages/core/src/index.ts';

// ---------------------------------------------------------------------------------------------
// Tokens (sin regex con \p{..}: con cadenas de cientos de KB el motor de regex desborda la pila).

export function addTokens(s: string, into: Set<string>, min = 4): Set<string> {
  let cur = '';
  const flush = () => {
    if (cur.length >= min && cur.length <= 64) into.add(cur.toLowerCase());
    cur = '';
  };
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 32;
    // Rápido para ASCII; fuera de ASCII, «letra» = tiene mayúscula/minúscula distinta.
    const word =
      c < 128
        ? (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
        : s[i]!.toLowerCase() !== s[i]!.toUpperCase();
    if (word) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      cur = s.slice(start, i);
      flush();
      start = -1;
    }
  }
  return into;
}

// ---------------------------------------------------------------------------------------------
// Capa 2: endurecimiento.

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
const ID_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,39}$/;
/** Valor de metadato aceptable: sin espacios, sin separadores de ruta, sin '@'. */
const SAFE_VALUE = /^[A-Za-z0-9_.:+\-\[\]<>]{0,120}$/;

export interface HardenContext {
  /** Términos de identidad en minúsculas (se comparan por token completo). */
  identity: Set<string>;
  /** Contadores de lo que la capa 2 tuvo que corregir. */
  stats: { keys: number; tags: number; values: number };
}

function isIdentityToken(s: string, identity: Set<string>): boolean {
  for (const t of addTokens(s, new Set(), 3)) if (identity.has(t)) return true;
  return false;
}

/** Placeholder de igual longitud para una clave, único dentro del objeto. */
function keyPlaceholder(k: string, used: Set<string>): string {
  const base = placeholder(k).replace(/\s/g, 'x') || 'x';
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

function hardenTags(s: string, ctx: HardenContext): string {
  return s.replace(TAG, (m, slash: string, name: string) => {
    if (KNOWN_TAGS.has(name) && !ctx.identity.has(name)) return m;
    // D-20: `<xxxx>` ya es el placeholder que puso el core (sanitizeTranscriptLine reemplaza las
    // etiquetas desconocidas desde fixes-1): no es una corrección de esta capa, no se cuenta.
    if (/^x+$/.test(name)) return m;
    ctx.stats.tags++;
    return `<${slash}${'x'.repeat(name.length)}>`;
  });
}

const isPlaceholderish = (s: string) => /^[x\s]*$/.test(s.replace(TAG, ''));

function hardenValue(v: unknown, ctx: HardenContext): unknown {
  if (typeof v === 'string') {
    if (isPlaceholderish(v)) return v.includes('<') ? hardenTags(v, ctx) : v;
    // Valor conservado por el core (metadato): sólo si tiene forma de id/enum y no identifica a nadie.
    if (SAFE_VALUE.test(v) && !isIdentityToken(v, ctx.identity)) return v;
    ctx.stats.values++;
    return placeholder(v).replace(/[^\sx]/g, 'x');
  }
  if (Array.isArray(v)) return v.map((x) => hardenValue(x, ctx));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    const used = new Set<string>();
    for (const [k, x] of Object.entries(v)) {
      let key = k;
      if (!ID_KEY.test(k) || isIdentityToken(k, ctx.identity)) {
        key = keyPlaceholder(k, used);
        ctx.stats.keys++;
      }
      used.add(key);
      out[key] = hardenValue(x, ctx);
    }
    return out;
  }
  return v;
}

/** Sanitiza una línea: core + capa 2. Líneas no JSON quedan como placeholder completo. */
export function sanitizeLine(line: string, ctx: HardenContext): string {
  const s = sanitizeTranscriptLine(line);
  if (!s.trim()) return s;
  try {
    return JSON.stringify(hardenValue(JSON.parse(s), ctx));
  } catch {
    return s.replace(/[^\s]/g, 'x');
  }
}

// ---------------------------------------------------------------------------------------------
// Identidad.

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

const FREE_KEYS = new Set(['input', 'toolUseResult', 'snapshot', 'answers', 'structuredContent', 'attachment']);
const ENUM_KEYS = new Set(['type', 'role', 'subtype', 'level', 'userType', 'entrypoint', 'stop_reason', 'service_tier', 'speed', 'content_type', 'media_type', 'agentType', 'model']);

const GENERIC = new Set([
  'users', 'home', 'appdata', 'local', 'roaming', 'temp', 'tmp', 'program', 'files', 'windows', 'documents',
  'desktop', 'downloads', 'repos', 'src', 'dev', 'code', 'projects', 'claude', 'main', 'master', 'develop', 'head',
  'test', 'tests', 'api', 'app', 'apps', 'packages', 'scripts', 'docs', 'node_modules', 'onedrive',
]);

/** Términos de identidad: usuario/host del sistema + segmentos de `cwd`, ramas git y emails vistos. */
export function identityTerms(records: unknown[], extra: string[] = []): Set<string> {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    if (!s) return;
    for (const t of addTokens(s, new Set(), 3)) if (!GENERIC.has(t)) out.add(t);
  };
  // Usuario/host del sistema y extras: siempre identidad (se agregan al final, después del filtro).
  const system: string[] = [hostname(), ...extra];
  try {
    system.push(userInfo().username);
  } catch {
    /* sin usuario */
  }
  // Claves con forma de identificador = vocabulario del esquema: nunca se tratan como identidad
  // (una rama llamada «usage» no debe renombrar la clave usage que lee el parser).
  const schema = new Set<string>(KNOWN_TAGS);
  // `free` = dentro de un objeto libre (input de herramienta, toolUseResult, snapshot): ahí claves y
  // valores son contenido y NO alimentan el vocabulario del esquema.
  const visit = (v: unknown, key?: string, free = false) => {
    if (typeof v === 'string') {
      if (key === 'cwd' || key === 'gitBranch') add(v);
      // Valores enumerados del esquema (type: "assistant", role, subtype...) tampoco son identidad:
      // un proyecto «qa-lead-assistant» no debe borrar type:"assistant".
      if (!free && key && ENUM_KEYS.has(key) && SAFE_VALUE.test(v)) addTokens(v, schema, 3);
      for (const m of findEmails(v)) add(m);
      return;
    }
    if (Array.isArray(v)) v.forEach((x) => visit(x, undefined, free));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (!free && ID_KEY.test(k)) schema.add(k.toLowerCase());
        visit(x, k, free || FREE_KEYS.has(k));
      }
  };
  records.forEach((r) => visit(r));
  for (const t of schema) out.delete(t);
  for (const x of system) add(x);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Verificación de fuga.

export interface LeakReport {
  /** Tokens del contenido original (strings reemplazados) que aparecen en el resultado. */
  survivors: string[];
  /** Términos de identidad presentes en el resultado (debe ser vacío). */
  identityHits: string[];
  /** Patrones de ruta/email presentes en el resultado (debe ser vacío). */
  patternHits: string[];
  ok: boolean;
}

const PATTERNS: [RegExp, string][] = [
  [/[A-Za-z]:\\\\|[A-Za-z]:\//, 'ruta Windows'],
  [/\/(?:Users|home)\/[^/"\s]/, 'ruta de usuario'],
];

/** Recolecta tokens de strings del original que el sanitizador cambió (contenido). */
function contentTokens(orig: unknown, san: unknown, into: Set<string>): void {
  if (typeof orig === 'string') {
    if (orig !== san) addTokens(orig, into);
    return;
  }
  if (Array.isArray(orig)) {
    orig.forEach((x, i) => contentTokens(x, Array.isArray(san) ? san[i] : undefined, into));
    return;
  }
  if (orig && typeof orig === 'object') {
    // Las claves renombradas también son contenido; se emparejan por posición.
    const sk = san && typeof san === 'object' ? Object.keys(san) : [];
    Object.entries(orig).forEach(([k, x], i) => {
      if (sk[i] !== undefined && sk[i] !== k) addTokens(k, into);
      contentTokens(x, san && typeof san === 'object' ? (san as any)[sk[i] ?? k] : undefined, into);
    });
  }
}

export function leakCheck(originalLines: string[], sanitizedLines: string[], identity: Set<string>): LeakReport {
  const content = new Set<string>();
  const outTokens = new Set<string>();
  const patternHits = new Set<string>();
  for (let i = 0; i < sanitizedLines.length; i++) {
    const o = originalLines[i] ?? '';
    const s = sanitizedLines[i] ?? '';
    addTokens(s, outTokens, 3);
    for (const [re, label] of PATTERNS) if (re.test(s)) patternHits.add(label);
    if (findEmails(s).length) patternHits.add('email');
    let oj: unknown;
    let sj: unknown;
    try {
      oj = JSON.parse(o);
      sj = JSON.parse(s);
    } catch {
      addTokens(o, content);
      continue;
    }
    contentTokens(oj, sj, content);
  }
  const survivors = [...content].filter((t) => outTokens.has(t)).sort();
  const identityHits = [...identity].filter((t) => outTokens.has(t)).sort();
  return { survivors, identityHits, patternHits: [...patternHits], ok: identityHits.length === 0 && patternHits.size === 0 };
}

// ---------------------------------------------------------------------------------------------
// Rasgos del transcript y equivalencia de uso.

export interface Features {
  ephemeral1h: boolean;
  toolError: boolean;
  subagents: number;
}

export function features(lines: string[], subagents: number): Features {
  let ephemeral1h = false;
  let toolError = false;
  for (const l of lines) {
    if (!ephemeral1h && /"ephemeral_1h_input_tokens":[1-9]/.test(l)) ephemeral1h = true;
    if (!toolError && /"is_error":true/.test(l)) toolError = true;
    if (ephemeral1h && toolError) break;
  }
  return { ephemeral1h, toolError, subagents };
}

export interface UsageSummary {
  events: number;
  sidechainEvents: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  toolCalls: number;
  failedToolCalls: number;
  models: string[];
}

export function usageOf(files: { lines: string[]; sidechain: boolean }[]): UsageSummary {
  const s: UsageSummary = { events: 0, sidechainEvents: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, failedToolCalls: 0, models: [] };
  const models = new Set<string>();
  for (const f of files) {
    const p = new ClaudeCodeParser(f.sidechain ? { sidechain: true } : {});
    const evs: TurnEvent[] = f.lines.flatMap((l) => p.feed(l));
    for (const e of evs) {
      if ((e.phase ?? 'response') !== 'response') continue;
      s.events++;
      if (e.sidechain) s.sidechainEvents++;
      s.input += e.tokens.input;
      s.output += e.tokens.output;
      s.cacheRead += e.tokens.cacheRead ?? 0;
      s.cacheWrite += e.tokens.cacheWrite ?? 0;
      s.toolCalls += e.toolCalls?.length ?? 0;
      s.failedToolCalls += e.toolCalls?.filter((t) => t.failed).length ?? 0;
      if (e.model) models.add(e.model);
    }
  }
  s.models = [...models].sort();
  return s;
}

/** Diferencias de uso entre original y sanitizado (debe ser vacío: el uso se conserva). */
export function usageDiff(a: UsageSummary, b: UsageSummary): string[] {
  const out: string[] = [];
  for (const k of ['events', 'sidechainEvents', 'input', 'output', 'cacheRead', 'cacheWrite', 'toolCalls', 'failedToolCalls'] as const)
    if (a[k] !== b[k]) out.push(`${k}: ${a[k]} ≠ ${b[k]}`);
  if (a.models.join() !== b.models.join()) out.push(`models: ${a.models.join()} ≠ ${b.models.join()}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Lectura acotada.

export interface Truncation {
  maxLines: number;
  maxBytes: number;
}

/** Líneas completas (descarta la última si no terminó de escribirse), con tope de líneas/bytes. */
export function boundedLines(text: string, t: Truncation): string[] {
  const all = text.split('\n');
  if (!text.endsWith('\n')) all.pop();
  const out: string[] = [];
  let bytes = 0;
  for (const l of all) {
    if (!l.trim()) continue;
    if (out.length >= t.maxLines) break;
    bytes += Buffer.byteLength(l) + 1;
    if (out.length > 0 && bytes > t.maxBytes) break;
    out.push(l);
  }
  return out;
}

export function firstTimestamp(lines: string[]): number {
  for (const l of lines) {
    const m = /"timestamp":"([^"]+)"/.exec(l);
    if (m) return Date.parse(m[1]!) || 0;
  }
  return 0;
}

export function lastTimestamp(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /"timestamp":"([^"]+)"/.exec(lines[i]!);
    if (m) return Date.parse(m[1]!) || 0;
  }
  return 0;
}

/**
 * Elige N sesiones cubriendo, si existen, los rasgos pedidos por CP-003.1 (subagentes, ephemeral 1h,
 * tool_result con error); completa con las más recientes.
 */
export function pickSets<T extends { features: Features }>(candidates: T[], n: number): T[] {
  const picked: T[] = [];
  const want: ((f: Features) => boolean)[] = [(f) => f.subagents > 0, (f) => f.ephemeral1h, (f) => f.toolError];
  const covered = (w: (f: Features) => boolean) => picked.some((p) => w(p.features));
  for (const w of want) {
    if (picked.length >= n || covered(w)) continue;
    const c = candidates.find((x) => !picked.includes(x) && w(x.features));
    if (c) picked.push(c);
  }
  for (const c of candidates) {
    if (picked.length >= n) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}
