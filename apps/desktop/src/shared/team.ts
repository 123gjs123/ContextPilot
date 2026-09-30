import { fmtPct, fmtTokens, MIN_BUCKET_SESSIONS, ruleName, TEAM_SCHEMA, type TeamExport } from '@contextpilot/core';

// CP-057.3: importación de N exportaciones de equipo y vista agregada. Puro, sin servidor.
// Formato tolerante: el daemon (`GET /team/export`) define la forma final; se aceptan
//  a) { rows: [{ week, provider?, ruleId?, sessions, inputTokens, outputTokens, cacheReadTokens, suggestions, accepted, savedTokens }] }
//  b) { byProvider: [{ provider, week?, sessions, input, output, cacheRead, savedTokens }], byRule: [{ ruleId, week?, fired, accepted, savedTokens }] }

export interface TeamRow {
  week: string;
  provider: string;
  ruleId: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  suggestions: number;
  accepted: number;
  savedTokens: number;
}

export interface TeamFile {
  name: string;
  rows: TeamRow[];
  warnings: string[];
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown, d: string): string => (typeof v === 'string' && v ? v : d);

function row(o: Record<string, unknown>, fallbackWeek: string): TeamRow {
  return {
    week: s(o.week, fallbackWeek),
    provider: s(o.provider, '*'),
    ruleId: s(o.ruleId, '*'),
    sessions: n(o.sessions),
    inputTokens: n(o.inputTokens ?? o.input),
    outputTokens: n(o.outputTokens ?? o.output),
    cacheReadTokens: n(o.cacheReadTokens ?? o.cacheRead),
    suggestions: n(o.suggestions ?? o.fired),
    accepted: n(o.accepted),
    savedTokens: n(o.savedTokens),
  };
}

/** Señales de que un archivo no está anonimizado (CP-057.2): hex ≥ 16, ULID/UUID, rutas. */
export function privacyWarnings(raw: string): string[] {
  const w: string[] = [];
  if (/\b[0-9a-f]{16,}\b/i.test(raw)) w.push('contiene cadenas hex largas (¿hashes?)');
  if (/\b[0-9A-HJKMNP-TV-Z]{26}\b/.test(raw) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(raw)) {
    w.push('contiene ids (ULID/UUID)');
  }
  if (/[A-Za-z]:\\\\|\/(Users|home)\//.test(raw)) w.push('contiene rutas de archivos');
  if (/"sessionId"/.test(raw)) w.push('contiene sessionId');
  return w;
}

export function parseTeamFile(name: string, raw: string): TeamFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { name, rows: [], warnings: ['JSON inválido'] };
  }
  const warnings = privacyWarnings(raw);
  if (!data || typeof data !== 'object') return { name, rows: [], warnings: [...warnings, 'formato desconocido'] };
  const o = data as Record<string, unknown>;
  const period = o.period as { from?: string } | undefined;
  const week = s(o.week, s(period?.from, 'sin semana').slice(0, 10));
  const rows: TeamRow[] = [];
  if (Array.isArray(o.rows)) for (const r of o.rows) if (r && typeof r === 'object') rows.push(row(r as Record<string, unknown>, week));
  if (Array.isArray(o.byProvider)) {
    for (const r of o.byProvider) if (r && typeof r === 'object') rows.push({ ...row(r as Record<string, unknown>, week), ruleId: '*', suggestions: 0, accepted: 0 });
  }
  if (Array.isArray(o.byRule)) {
    for (const r of o.byRule) {
      if (r && typeof r === 'object') {
        const x = row(r as Record<string, unknown>, week);
        // Las filas por regla no duplican sesiones ni tokens (ya están en byProvider).
        rows.push({ ...x, provider: s((r as Record<string, unknown>).provider, '*'), sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
      }
    }
  }
  if (!rows.length) warnings.push('sin filas agregadas');
  return { name, rows, warnings };
}

export interface TeamAggregate {
  files: { name: string; rows: number; warnings: string[] }[];
  weeks: string[];
  byProvider: { provider: string; sessions: number; inputText: string; outputText: string; cacheText: string; savedText: string }[];
  byRule: { ruleId: string; suggestions: number; accepted: number; acceptanceText: string; savedText: string }[];
  totals: { sessions: number; suggestions: number; acceptanceText: string; savedText: string };
}

export function mergeTeam(files: TeamFile[]): TeamAggregate {
  const all = files.flatMap((f) => f.rows);
  const prov = new Map<string, { sessions: number; input: number; output: number; cacheRead: number; saved: number }>();
  const rules = new Map<string, { suggestions: number; accepted: number; saved: number }>();
  for (const r of all) {
    if (r.provider !== '*' && (r.sessions || r.inputTokens || r.outputTokens)) {
      const p = prov.get(r.provider) ?? { sessions: 0, input: 0, output: 0, cacheRead: 0, saved: 0 };
      p.sessions += r.sessions;
      p.input += r.inputTokens;
      p.output += r.outputTokens;
      p.cacheRead += r.cacheReadTokens;
      if (r.ruleId === '*') p.saved += r.savedTokens;
      prov.set(r.provider, p);
    }
    if (r.ruleId !== '*') {
      const q = rules.get(r.ruleId) ?? { suggestions: 0, accepted: 0, saved: 0 };
      q.suggestions += r.suggestions;
      q.accepted += r.accepted;
      q.saved += r.savedTokens;
      rules.set(r.ruleId, q);
    }
  }
  const sessions = [...prov.values()].reduce((a, p) => a + p.sessions, 0);
  const suggestions = [...rules.values()].reduce((a, q) => a + q.suggestions, 0);
  const accepted = [...rules.values()].reduce((a, q) => a + q.accepted, 0);
  const saved = [...rules.values()].reduce((a, q) => a + q.saved, 0) || [...prov.values()].reduce((a, p) => a + p.saved, 0);
  return {
    files: files.map((f) => ({ name: f.name, rows: f.rows.length, warnings: f.warnings })),
    weeks: [...new Set(all.map((r) => r.week))].sort(),
    byProvider: [...prov.entries()]
      .sort((a, b) => b[1].sessions - a[1].sessions)
      .map(([provider, p]) => ({
        provider,
        sessions: p.sessions,
        inputText: fmtTokens(p.input),
        outputText: fmtTokens(p.output),
        cacheText: p.input + p.cacheRead ? fmtPct(p.cacheRead / (p.input + p.cacheRead)) : '—',
        savedText: `≈${fmtTokens(p.saved)}`,
      })),
    byRule: [...rules.entries()]
      .sort((a, b) => b[1].suggestions - a[1].suggestions)
      .map(([ruleId, q]) => ({
        ruleId,
        suggestions: q.suggestions,
        accepted: q.accepted,
        acceptanceText: q.suggestions ? fmtPct(q.accepted / q.suggestions) : '—',
        savedText: `≈${fmtTokens(q.saved)}`,
      })),
    totals: { sessions, suggestions, acceptanceText: suggestions ? fmtPct(accepted / suggestions) : '—', savedText: `≈${fmtTokens(saved)}` },
  };
}

// ---------------------------------------------------------------- CP-062: explicación y vista previa

/** Qué se exporta (texto del encabezado de la pestaña Equipo). */
export const TEAM_EXPORTED = [
  'Totales por semana y proveedor: cantidad de sesiones y tokens (entrada, salida, caché).',
  'Totales por semana y regla: sugerencias mostradas, aceptadas, ignoradas y pospuestas.',
  'Ahorro estimado (≈) de las sugerencias aceptadas.',
  'Fecha de generación (sólo el día).',
];

/** Qué NUNCA se exporta. */
export const TEAM_NEVER = [
  'Prompts, respuestas ni ningún texto de tus conversaciones.',
  'Nombres de proyecto, títulos, rutas ni nombres de archivo.',
  'Ids de sesión, hashes ni embeddings.',
  `Grupos con menos de ${MIN_BUCKET_SESSIONS} sesiones: se ocultan (no se puede aislar a una persona).`,
];

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', google: 'Google (Gemini)' };

export interface TeamExportView {
  ok: boolean;
  /** Motivo si no es una exportación válida. */
  error?: string;
  generatedAt: string;
  weeksText: string;
  contributors: number;
  suppressed: number;
  suppressedText: string;
  empty: boolean;
  totals: { sessions: number; tokensText: string; suggestions: number; accepted: number; acceptanceText: string; savedText: string };
  providers: { week: string; provider: string; sessions: number; inputText: string; outputText: string; cacheText: string; suggestions: number; acceptanceText: string; savedText: string }[];
  rules: { week: string; ruleId: string; ruleName: string; sessions: number; fired: number; accepted: number; dismissed: number; snoozed: number; acceptanceText: string; savedText: string }[];
}

const pct = (a: number, b: number) => (b ? fmtPct(a / b) : '—');

/** CP-062: vista previa legible de una exportación (la propia o un archivo del equipo). */
export function teamExportView(raw: unknown): TeamExportView {
  const e = raw as Partial<TeamExport> | undefined;
  const base: TeamExportView = {
    ok: false,
    generatedAt: '—',
    weeksText: '—',
    contributors: 0,
    suppressed: 0,
    suppressedText: '',
    empty: true,
    totals: { sessions: 0, tokensText: '0', suggestions: 0, accepted: 0, acceptanceText: '—', savedText: '≈0' },
    providers: [],
    rules: [],
  };
  if (!e || typeof e !== 'object' || e.schema !== TEAM_SCHEMA) return { ...base, error: 'No es una exportación de equipo de ContextPilot' };
  const byProvider = Array.isArray(e.byProvider) ? e.byProvider : [];
  const byRule = Array.isArray(e.byRule) ? e.byRule : [];
  const providers = byProvider.map((b) => ({
    week: b.week,
    provider: PROVIDER_LABEL[b.provider] ?? b.provider,
    sessions: b.sessions,
    inputText: fmtTokens(b.input),
    outputText: fmtTokens(b.output),
    cacheText: pct(b.cacheRead, b.input + b.cacheRead + b.cacheWrite),
    suggestions: b.suggestions,
    acceptanceText: pct(b.accepted, b.suggestions),
    savedText: `≈${fmtTokens(b.savedTokens)}`,
  }));
  const rules = byRule.map((b) => ({
    week: b.week,
    ruleId: b.ruleId,
    ruleName: ruleName(b.ruleId),
    sessions: b.sessions,
    fired: b.fired,
    accepted: b.accepted,
    dismissed: b.dismissed,
    snoozed: b.snoozed,
    acceptanceText: pct(b.accepted, b.fired),
    savedText: `≈${fmtTokens(b.savedTokens)}`,
  }));
  const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const suggestions = sum(byProvider, (b) => b.suggestions);
  const accepted = sum(byProvider, (b) => b.accepted);
  const suppressed = e.suppressedBuckets ?? 0;
  return {
    ok: true,
    generatedAt: e.generatedAt ?? '—',
    weeksText: e.weeks?.length ? e.weeks.join(', ') : '—',
    contributors: e.contributors ?? 1,
    suppressed,
    suppressedText: suppressed
      ? `${suppressed} grupo(s) ocultos por tener menos de ${e.minBucketSessions ?? MIN_BUCKET_SESSIONS} sesiones.`
      : 'Ningún grupo oculto.',
    empty: !providers.length && !rules.length,
    totals: {
      sessions: sum(byProvider, (b) => b.sessions),
      tokensText: fmtTokens(sum(byProvider, (b) => b.input + b.output + b.cacheRead + b.cacheWrite)),
      suggestions,
      accepted,
      acceptanceText: pct(accepted, suggestions),
      savedText: `≈${fmtTokens(sum(byProvider, (b) => b.savedTokens))}`,
    },
    providers,
    rules,
  };
}

/** Ejemplo corto de archivo (para la explicación de «Combinar»). */
export const TEAM_EXAMPLE = JSON.stringify(
  {
    schema: TEAM_SCHEMA,
    generatedAt: '2026-09-28',
    minBucketSessions: MIN_BUCKET_SESSIONS,
    contributors: 1,
    weeks: ['2026-W39'],
    byProvider: [{ week: '2026-W39', provider: 'anthropic', sessions: 12, input: 180000, output: 95000, cacheRead: 4200000, cacheWrite: 310000, suggestions: 9, accepted: 6, dismissed: 2, snoozed: 1, savedTokens: 240000 }],
    byRule: [{ week: '2026-W39', ruleId: 'R1', sessions: 6, fired: 7, accepted: 5, dismissed: 1, snoozed: 1, acceptanceRate: 0.714, savedTokens: 210000 }],
    suppressedBuckets: 3,
  },
  null,
  2,
);
