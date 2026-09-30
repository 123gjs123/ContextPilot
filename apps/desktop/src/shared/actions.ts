import { clearCommand, isCli, type Source } from '@contextpilot/core';
import type { Feedback, HandoffResponse, Suggestion } from './types.js';

// Qué hace cada acción de una sugerencia (CP-046.2/.3). Devuelve un plan puro; main lo ejecuta.

export type ActionPlan =
  | { kind: 'copy'; text: string; feedback: Feedback; message: string }
  | { kind: 'handoff'; sessionId: string; source: Source | undefined }
  | { kind: 'open-dashboard'; sessionId: string; feedback?: Feedback }
  | { kind: 'show-detail'; message: string }
  | { kind: 'error'; message: string };

export function planAction(s: Suggestion, actionIndex: number, source: Source | undefined): ActionPlan {
  const a = s.actions[actionIndex];
  if (!a) return { kind: 'error', message: 'Acción inexistente' };
  switch (a.kind) {
    case 'copy':
      if (!a.payload) return { kind: 'error', message: 'La acción no trae texto para copiar' };
      return { kind: 'copy', text: a.payload, feedback: 'accepted', message: `Copiado: ${a.payload.slice(0, 60)}` };
    case 'handoff':
      return { kind: 'handoff', sessionId: s.sessionId, source };
    case 'open-session':
      return { kind: 'open-dashboard', sessionId: s.sessionId, feedback: 'accepted' };
    case 'show-detail':
      return { kind: 'show-detail', message: a.payload ?? s.detail };
    default:
      return { kind: 'error', message: `Acción no soportada: ${String(a.kind)}` };
  }
}

/**
 * Texto que va al portapapeles tras `POST /handoff` (D «portapapeles»): el traspaso y, para
 * CLIs, la instrucción con el comando de limpieza del cliente (`/clear` o `/new`).
 */
export function handoffClipboardText(res: HandoffResponse, source: Source | undefined): { text: string; message: string } {
  const cmd = res.command ?? (source ? clearCommand(source) : null);
  const method = res.method === 'extractive' ? ' (resumen extractivo local)' : '';
  if (source && isCli(source) && cmd) {
    const text = `${res.summary.trim()}\n\n---\nPasos: ejecutá ${cmd} en la sesión y pegá este traspaso como primer mensaje.`;
    return { text, message: `Traspaso copiado${method}. Ejecutá ${cmd} y pegalo.` };
  }
  return {
    text: res.summary.trim(),
    message: `Traspaso copiado${method}. Abrí un chat nuevo y pegalo (no se envía solo).`,
  };
}
