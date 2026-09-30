import type { Provider, Source, Suggestion } from './types.js';

// Traducción de acciones por cliente (SPEC §5).

export function compactCommand(source: Source, focus?: string): string | null {
  switch (source) {
    case 'claude-code':
      return focus ? `/compact ${focus}` : '/compact';
    case 'codex':
      return '/compact';
    case 'gemini-cli':
      return '/compress';
    default:
      return null;
  }
}

export function clearCommand(source: Source): string | null {
  switch (source) {
    case 'claude-code':
    case 'gemini-cli':
      return '/clear';
    case 'codex':
      return '/new';
    default:
      return null;
  }
}

export function modelCommand(source: Source, model: string): string | null {
  return isCli(source) ? `/model ${model}` : null;
}

export function isCli(source: Source): boolean {
  return source === 'claude-code' || source === 'codex' || source === 'gemini-cli';
}

export function isChatUi(source: Source): boolean {
  return source === 'web' || source === 'desktop';
}

// ---------- D-1: sugerencias de cuenta ----------

/** sessionId sintético de las sugerencias de cuenta (R10): una por proveedor. */
export function accountSessionId(provider: Provider): string {
  return `account:${provider}`;
}

export function isAccountSessionId(sessionId: string): boolean {
  return sessionId.startsWith('account:');
}

export function accountProvider(sessionId: string): Provider | undefined {
  const p = sessionId.slice('account:'.length);
  return isAccountSessionId(sessionId) && (p === 'anthropic' || p === 'openai' || p === 'google') ? p : undefined;
}

// ---------- D-3: acción corta para la statusline ----------

/** Acción corta por regla (statusline, tray): nunca el texto a copiar. */
const SHORT_BY_RULE: Record<string, string> = {
  R2: 'traspaso',
  R3: 'caché rota',
  R4: 'sesión nueva',
  R5: 'grep/head',
  R6: 'MCP sin uso',
  R8: 'loop!',
  R9: 'bloque repetido',
  W1: 'traspaso',
  W2: 'Project/Gem',
  W3: 'reformulá',
  W4: 'modo normal',
};

export function shortAction(s: Pick<Suggestion, 'ruleId' | 'actions' | 'title'>): string {
  // Reglas cuyo payload es un comando de barra (R1, R7, G1, G2): el comando sin argumentos.
  const cmd = s.actions.find((a) => a.kind === 'copy' && a.payload?.startsWith('/'));
  if (cmd && ['R1', 'R7', 'G1', 'G2'].includes(s.ruleId)) return cmd.payload!.split(' ')[0]!;
  if (s.ruleId === 'R10') {
    const hhmm = /\b(\d\d:\d\d)\b/.exec(s.title)?.[1];
    return hhmm ? `límite ${hhmm}` : 'límite';
  }
  const fixed = SHORT_BY_RULE[s.ruleId];
  if (fixed) return fixed;
  if (cmd) return cmd.payload!.split(' ')[0]!;
  if (s.actions.some((a) => a.kind === 'handoff')) return 'traspaso';
  return s.title.length > 24 ? `${s.title.slice(0, 23)}…` : s.title;
}
