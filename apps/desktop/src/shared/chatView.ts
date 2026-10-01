import { prettyServerName, prettyToolName } from '@contextpilot/core';
import type { ChatState } from './chat.js';
import type { ChatRecordView } from './types.js';

// Vista del chat (pura): resumen de herramientas, autocompletado de «/» y nombres de los chats.

export const CHAT_MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Modelo predeterminado' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Una línea que describe la llamada a una herramienta («Bash · npm test»). */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const label = name.startsWith('mcp__') ? prettyToolName(name) : name;
  const detail =
    str('command') ||
    str('file_path') ||
    str('path') ||
    str('pattern') ||
    str('url') ||
    str('query') ||
    str('skill') ||
    str('description') ||
    str('prompt') ||
    '';
  return detail ? `${label} · ${short(detail.replace(/\s+/g, ' '))}` : label;
}

export interface SlashItem {
  value: string;
  kind: 'skill' | 'comando';
}

/** Sugerencias para lo que el usuario escribe después de «/» (skills primero). */
export function slashSuggestions(s: Pick<ChatState, 'skills' | 'slashCommands'>, typed: string, max = 8): SlashItem[] {
  if (!typed.startsWith('/') || /\s/.test(typed)) return [];
  const q = typed.slice(1).toLowerCase();
  const skills = new Set(s.skills);
  const all: SlashItem[] = [
    ...s.skills.map((v) => ({ value: v, kind: 'skill' as const })),
    ...s.slashCommands.filter((c) => !skills.has(c)).map((v) => ({ value: v, kind: 'comando' as const })),
  ];
  const starts = all.filter((x) => x.value.toLowerCase().startsWith(q));
  const contains = all.filter((x) => !x.value.toLowerCase().startsWith(q) && x.value.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, max);
}

/** Nombre del chat: el de la sesión (proyecto — título) si el daemon lo conoce; si no, la carpeta. */
export function chatName(rec: Pick<ChatRecordView, 'cwd' | 'sessionId' | 'createdAt'>, sessionNames: Record<string, string>): string {
  const fromSession = rec.sessionId ? sessionNames[rec.sessionId] : undefined;
  if (fromSession) return fromSession;
  const folder = rec.cwd.split(/[\\/]/).filter(Boolean).pop() ?? rec.cwd;
  return `${folder} — chat nuevo`;
}

export const STATUS_TEXT: Record<ChatState['status'], string> = {
  idle: 'Listo',
  starting: 'Iniciando…',
  running: 'Respondiendo…',
  exited: 'Inactivo',
  error: 'Error',
};

/** MCP conectados / con problema, para el encabezado. */
export function mcpSummary(s: Pick<ChatState, 'mcp'>): string {
  if (!s.mcp.length) return '';
  const ok = s.mcp.filter((m) => m.status === 'connected').length;
  const bad = s.mcp.filter((m) => m.status !== 'connected' && m.status !== 'pending').map((m) => prettyServerName(`mcp__${m.name}`));
  return `MCP ${ok}/${s.mcp.length}${bad.length ? ` · sin conectar: ${bad.join(', ')}` : ''}`;
}
