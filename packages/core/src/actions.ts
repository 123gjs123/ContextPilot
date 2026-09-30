import type { Source } from './types.js';

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
