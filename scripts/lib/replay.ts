// CP-003.2 / D-7: harness de replay reutilizable.
//
// 1. replay(files, { sourceParser, config }): reproduce transcripts (reales o fixtures) a través del
//    parser de la fuente + applyEvent + RuleEngine, como lo haría el daemon, y devuelve eventos,
//    sugerencias por regla y la métrica por hora activa (hora activa = hora UTC con ≥ 1 turno).
// 2. streamReplay(src, dest, { speed }): re-escribe un fixture línea por línea en otro archivo
//    (append, con una línea partida en dos escrituras) para ejercitar tailers como escritura en vivo.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  ClaudeCodeParser,
  CodexParser,
  GeminiTelemetryParser,
  RuleEngine,
  applyEvent,
  codexSessionIdFromPath,
  defaultConfig,
  mergeConfig,
  parseGeminiOutfile,
  type Config,
  type Feedback,
  type SessionState,
  type Suggestion,
  type TurnEvent,
} from '../../packages/core/src/index.ts';
import { subagentParent } from './transcripts.ts';

export type SourceParserKind = 'claude-code' | 'codex' | 'gemini-cli';

/** Parser genérico: recibe el texto completo de un archivo y devuelve sus eventos. */
export interface FileParser {
  parse(text: string): TurnEvent[];
  errors(): number;
}

export type ParserFactory = (file: string) => FileParser;

export interface ReplayOptions {
  /** Tipo de fuente (default 'claude-code') o fábrica propia de parsers por archivo. */
  sourceParser?: SourceParserKind | ParserFactory;
  /** Configuración parcial que se mezcla sobre defaultConfig(). */
  config?: Partial<Config>;
  /** Qué hace el «usuario» con cada sugerencia publicada (default 'dismissed', como el script histórico). */
  feedback?: Feedback | 'none';
  /** Si se indica, sólo se reportan estas reglas (el motor igual evalúa todas). */
  rules?: string[];
}

export interface ActiveHourMetric {
  /** Horas UTC distintas con ≥ 1 turno (evento). */
  activeHours: number;
  /** Turnos = pares (sesión, turn) distintos del hilo principal (DECISIONS «granularidad»). */
  turns: number;
  /** Llamadas a la API (eventos 'response', incluye subagentes). */
  calls: number;
  suggestions: number;
  suggestionsPerActiveHour: number;
  /** Sugerencias por hora activa, por regla. */
  byRule: Record<string, number>;
}

export interface ReplayResult {
  events: TurnEvent[];
  sessions: Record<string, SessionState>;
  suggestions: Suggestion[];
  /** Sugerencias publicadas por regla. */
  suggestionsByRule: Record<string, number>;
  /** Disparos suprimidos (cooldown / agrupadas / visible) por regla: ruido evitado. */
  suppressedByRule: Record<string, number>;
  perActiveHour: ActiveHourMetric;
  /** Líneas/registros inválidos por archivo (sólo archivos con errores). */
  errors: { file: string; count: number }[];
}

const HOUR_MS = 3_600_000;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Fábrica de parsers por tipo de fuente. Claude Code detecta subagentes por la ruta. */
export function parserFor(kind: SourceParserKind, file: string): FileParser {
  if (kind === 'claude-code') {
    // Los registros de subagentes ya traen el sessionId del padre; la ruta sólo indica sidechain
    // (así los fixtures `real-<n>/subagents/*.jsonl` se atribuyen igual que los originales).
    const p = new ClaudeCodeParser(subagentParent(file) ? { sidechain: true } : {});
    return { parse: (t) => t.split('\n').flatMap((l) => p.feed(l)), errors: () => p.errors };
  }
  if (kind === 'codex') {
    const p = new CodexParser({ sessionId: codexSessionIdFromPath(file) });
    return { parse: (t) => t.split('\n').flatMap((l) => p.feed(l)), errors: () => p.errors };
  }
  const p = new GeminiTelemetryParser();
  return { parse: (t) => parseGeminiOutfile(t).flatMap((r) => p.feed(r)), errors: () => p.errors };
}

export function replay(files: string[], opts: ReplayOptions = {}): ReplayResult {
  const factory: ParserFactory =
    typeof opts.sourceParser === 'function' ? opts.sourceParser : (f) => parserFor((opts.sourceParser as SourceParserKind) ?? 'claude-code', f);
  const config = mergeConfig(defaultConfig(), opts.config);
  const feedback = opts.feedback ?? 'dismissed';
  const only = opts.rules?.length ? new Set(opts.rules) : undefined;

  // 1) Parsear todos los archivos; los eventos se ordenan por timestamp (orden estable) para que
  //    los subagentes se intercalen con su sesión padre como en vivo.
  const events: TurnEvent[] = [];
  const errors: { file: string; count: number }[] = [];
  for (const file of files) {
    const p = factory(file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      errors.push({ file, count: 1 });
      continue;
    }
    events.push(...p.parse(text));
    if (p.errors() > 0) errors.push({ file, count: p.errors() });
  }
  const ms = (e: TurnEvent) => Date.parse(e.ts) || 0;
  events.sort((a, b) => ms(a) - ms(b));

  // 2) Estado + motor, igual que el pipeline del daemon.
  const engine = new RuleEngine(config);
  const sessions: Record<string, SessionState> = {};
  const suggestions: Suggestion[] = [];
  const suggestionsByRule: Record<string, number> = {};
  const suppressedByRule: Record<string, number> = {};
  const hours = new Set<number>();
  const turns = new Set<string>();
  let calls = 0;
  for (const ev of events) {
    const prev = sessions[ev.sessionId];
    const state = applyEvent(prev, ev);
    sessions[ev.sessionId] = state;
    const now = ms(ev);
    hours.add(Math.floor(now / HOUR_MS));
    if ((ev.phase ?? 'response') === 'response') calls++;
    if (!ev.sidechain) turns.add(`${ev.sessionId}#${ev.turn}`);
    const out = engine.evaluate({ event: ev, prev, state, now });
    for (const s of out.published) {
      if (!only || only.has(s.ruleId)) {
        suggestions.push(s);
        suggestionsByRule[s.ruleId] = (suggestionsByRule[s.ruleId] ?? 0) + 1;
      }
      // Simula la respuesta del usuario para que la sugerencia visible no bloquee a la siguiente.
      if (feedback !== 'none') engine.feedback(s.id, feedback, now);
    }
    for (const s of out.suppressed) {
      if (!only || only.has(s.ruleId)) suppressedByRule[s.ruleId] = (suppressedByRule[s.ruleId] ?? 0) + 1;
    }
  }

  const activeHours = hours.size;
  const per = (n: number) => (activeHours > 0 ? round(n / activeHours) : 0);
  const byRule = Object.fromEntries(Object.entries(suggestionsByRule).map(([k, v]) => [k, per(v)]));
  return {
    events,
    sessions,
    suggestions,
    suggestionsByRule,
    suppressedByRule,
    perActiveHour: {
      activeHours,
      turns: turns.size,
      calls,
      suggestions: suggestions.length,
      suggestionsPerActiveHour: per(suggestions.length),
      byRule,
    },
    errors,
  };
}

export interface StreamReplayOptions {
  /** Factor de velocidad sobre los timestamps reales (100 = ×100). 0/Infinity = sin esperas. */
  speed?: number;
  /** Tope de espera entre líneas (ms), para que pausas largas no bloqueen el test. */
  maxDelayMs?: number;
  /** Índice de la línea que se escribe partida en dos appends (default: la del medio). -1 = ninguna. */
  splitLine?: number;
  /** Callback tras cada append (p. ej. para que el test haga poll del tailer). */
  onWrite?: (chunk: string) => void | Promise<void>;
}

const tsOf = (line: string): number => {
  const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
  return m ? Date.parse(m[1]!) || 0 : 0;
};

/**
 * Reproduce `src` en `dest` como escritura en vivo: crea `dest` vacío y hace append línea por línea
 * respetando (acelerados por `speed`) los intervalos entre timestamps. Una línea se escribe partida
 * en dos appends para probar que el tailer no procesa líneas incompletas.
 */
export async function streamReplay(src: string, dest: string, opts: StreamReplayOptions = {}): Promise<number> {
  const lines = readFileSync(src, 'utf8').split('\n').filter((l) => l.length > 0);
  const speed = opts.speed ?? 100;
  const maxDelay = opts.maxDelayMs ?? 250;
  const split = opts.splitLine ?? Math.floor(lines.length / 2);
  writeFileSync(dest, '');
  let prevTs = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = tsOf(line);
    if (speed > 0 && Number.isFinite(speed) && prevTs && t > prevTs) {
      const wait = Math.min(maxDelay, (t - prevTs) / speed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    if (t) prevTs = t;
    const chunks = i === split && line.length > 1 ? [line.slice(0, line.length >> 1), line.slice(line.length >> 1) + '\n'] : [line + '\n'];
    for (const c of chunks) {
      appendFileSync(dest, c);
      await opts.onWrite?.(c);
    }
  }
  return lines.length;
}
