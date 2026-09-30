import type { SessionView, SuggestionWithFeedback } from './types.js';

// CP-051.3: CSV con una fila por sugerencia, sin contenido (ni título, ni detalle, ni payloads).

export const SUGGESTION_CSV_COLUMNS = [
  'suggestion_id',
  'rule_id',
  'session_id',
  'provider',
  'source',
  'client',
  'severity',
  'created_at',
  'expires_at',
  'feedback',
  'estimated_saving_tokens',
  'estimated',
] as const;

export function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  // Neutraliza fórmulas al abrir en Excel (CSV injection) y escapa comillas.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: readonly string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

export function suggestionsCsv(items: { session: SessionView; suggestions: SuggestionWithFeedback[] }[]): string {
  const rows: unknown[][] = [];
  for (const { session, suggestions } of items) {
    for (const s of suggestions) {
      rows.push([
        s.id,
        s.ruleId,
        s.sessionId,
        session.provider,
        session.source,
        session.client,
        s.severity,
        s.createdAt ?? '',
        s.expiresAt,
        s.feedback ?? '',
        s.estimatedSavingTokens ?? '',
        s.estimated ?? session.estimated,
      ]);
    }
  }
  rows.sort((a, b) => String(a[7]).localeCompare(String(b[7])));
  return toCsv(SUGGESTION_CSV_COLUMNS, rows);
}
