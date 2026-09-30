// Reglas que aplican a chats web (fuentes con 'web' en core) y su etiqueta para el side panel.
// Los toggles cambian `rules.<id>.enabled` vía PUT /config (la config del daemon es global).
import type { SiteId } from './sites.js';

const LABELS: Record<string, string> = {
  W1: 'Conversación larga → chat nuevo con resumen',
  W2: 'Adjunto re-subido',
  W3: 'Regeneraciones repetidas',
  W4: 'Modo caro para tarea trivial',
  R4: 'Tarea nueva en conversación vieja',
  R9: 'Bloque grande repetido',
  R10: 'Ritmo contra el límite del plan',
  G2: 'Contexto enorme en Gemini',
};

export function webRulesFor(site: SiteId): { id: string; label: string; enabled: boolean }[] {
  const ids = ['W1', 'W3', 'W2', 'W4', 'R4', 'R9', 'R10', ...(site === 'gemini.google.com' ? ['G2'] : [])];
  return ids.map((id) => ({ id, label: LABELS[id] ?? id, enabled: true }));
}
