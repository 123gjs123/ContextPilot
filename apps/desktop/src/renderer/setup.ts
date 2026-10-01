import type { SetupItem } from '../shared/setup.js';
import { clear, cp, h, toast } from './dom.js';

// Pestaña «Puesta en marcha»: qué falta y el comando para resolverlo (se copia y se pega en una
// terminal propia; ContextPilot no cambia la configuración de Claude Code por su cuenta).

const ICON: Record<SetupItem['status'], string> = { ok: '✓', missing: '✖', warn: '!', optional: '○' };
const STATUS: Record<SetupItem['status'], string> = { ok: 'Listo', missing: 'Falta', warn: 'Recomendado', optional: 'Opcional' };

export async function renderSetup(root: HTMLElement, force = false): Promise<void> {
  clear(root);
  root.append(h('p', { class: 'muted' }, 'Revisando…'));
  const items = await cp().setup(force);
  if (!root.isConnected) return;
  clear(root);
  const missing = items.filter((i) => i.required && i.status !== 'ok').length;
  root.append(
    h('section', { class: 'card setup' },
      h('div', { class: 'setup-head' },
        h('h2', {}, 'Puesta en marcha'),
        h('button', { onclick: () => void renderSetup(root, true) }, 'Volver a revisar')),
      h('p', { class: missing ? 'setup-summary bad' : 'setup-summary ok' },
        missing ? `Faltan ${missing} paso${missing > 1 ? 's' : ''} obligatorio${missing > 1 ? 's' : ''} para usar ContextPilot.` : 'Lo obligatorio está listo. Los pasos recomendados suman funciones.'),
      h('p', { class: 'muted small' }, 'Cada comando se copia con un clic: pegalo en una terminal PowerShell propia. Los que cambian la configuración de Claude Code los ejecutás vos.'),
      h('ol', { class: 'setup-list' },
        ...items.map((i) =>
          h('li', { class: `setup-item st-${i.status}` },
            h('span', { class: 'setup-icon', 'aria-hidden': 'true' }, ICON[i.status]),
            h('div', { class: 'setup-body' },
              h('div', { class: 'setup-title' },
                h('strong', {}, i.label),
                h('span', { class: `pill ${i.status === 'ok' ? 'ok' : i.status === 'missing' ? 'bad' : ''}` }, i.required && i.status !== 'ok' ? `${STATUS[i.status]} · obligatorio` : STATUS[i.status])),
              h('p', { class: 'muted small' }, i.detail),
              i.command && i.status !== 'ok'
                ? h('div', { class: 'setup-cmd' },
                    h('code', {}, i.command),
                    h('button', { onclick: async () => {
                      const r = await cp().copyText(i.command!);
                      toast(r.message, !r.ok);
                    } }, 'Copiar'))
                : null)))),
      h('p', { class: 'muted small' }, 'Instalación completa desde cero: scripts/setup.ps1 (ver docs/INSTALL.md, «Primer arranque»).')),
  );
}

/** Cantidad de pasos obligatorios sin resolver (para el aviso en «En vivo»). */
export async function setupMissingCount(): Promise<number> {
  try {
    return (await cp().setup()).filter((i) => i.required && i.status !== 'ok').length;
  } catch {
    return 0;
  }
}
