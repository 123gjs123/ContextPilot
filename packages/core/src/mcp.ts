// R6 / R11: desactivar y reactivar servidores MCP de Claude Code desde las UIs. Puro.
// Un servidor se identifica por su prefijo de herramienta `mcp__<servidor>` (el mismo nombre que usa
// una regla `permissions.deny` pelada de Claude Code, que saca sus herramientas del contexto).

/** true si `name` es un prefijo de servidor (`mcp__srv`), no una herramienta (`mcp__srv__tool`). */
export function isMcpServerKey(name: string): boolean {
  return /^mcp__[A-Za-z0-9_-]+$/.test(name) && name.split('__').length === 2;
}

/** «mcp__claude_ai_Atlassian_Rovo» → «Atlassian Rovo». */
export function prettyServerName(key: string): string {
  const s = key.replace(/^mcp__/, '').replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim();
  return s || key;
}

/** Palabras que, en un prompt, sugieren que hace falta ese servidor (además de su propio nombre). */
const ALIASES: Record<string, string[]> = {
  atlassian: ['jira', 'confluence'],
  rovo: ['jira', 'confluence'],
  gmail: ['mail', 'mails', 'correo', 'correos', 'email', 'emails', 'inbox'],
  calendar: ['calendario', 'reunión', 'reunion', 'reuniones', 'agenda'],
  drive: ['google docs', 'google sheets', 'planilla', 'spreadsheet'],
  github: ['pull request'],
  bigquery: ['dataset'],
  playwright: ['navegador', 'browser'],
};

const IGNORED = new Set(['mcp', 'claude', 'ai', 'server', 'servers', 'plugin', 'the', 'and']);

/** Palabras clave (minúsculas) que identifican a un servidor en un prompt. */
export function serverKeywords(key: string): string[] {
  const words = key
    .replace(/^mcp__/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_:.-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !IGNORED.has(w));
  const out = new Set(words);
  for (const w of words) for (const a of ALIASES[w] ?? []) out.add(a);
  return [...out];
}

function normalize(s: string): string {
  return ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
}

/**
 * Servidores (de `disabled`) que el prompt parece necesitar: alguna palabra clave aparece como
 * palabra completa. El texto del prompt no se guarda: se usa y se descarta.
 */
export function serversMentioned(prompt: string, disabled: string[]): string[] {
  if (!prompt || !disabled.length) return [];
  const text = normalize(prompt);
  return disabled.filter((key) => serverKeywords(key).some((k) => text.includes(normalize(k))));
}

/** Payload de las acciones `mcp-disable` / `mcp-enable`: servidores separados por coma. */
export function encodeServers(keys: string[]): string {
  return keys.join(',');
}

export function decodeServers(payload: string | undefined): string[] {
  return [...new Set((payload ?? '').split(',').map((s) => s.trim()).filter(isMcpServerKey))];
}

/** Guía paso a paso para R6 (botón «Guía paso a paso» de la tarjeta). */
export function mcpDisableGuide(keys: string[], canToggle: boolean): string {
  const list = keys.map((k) => `• ${prettyServerName(k)}`).join('\n');
  const auto = canToggle
    ? [
        'Opción rápida (desde acá):',
        '1. Tocá «Desactivar en este proyecto». ContextPilot agrega una regla de bloqueo por servidor en <proyecto>/.claude/settings.local.json (sólo tuyo, no se versiona).',
        '2. Claude Code recarga ese archivo solo: desde el próximo turno esas herramientas dejan de viajar en cada pedido. Si no lo notás, ejecutá /mcp o abrí una sesión nueva.',
        '3. Para volver atrás, en esta misma tarjeta aparece «MCP desactivados en este proyecto» con un botón «Reactivar» por servidor. Si más adelante pedís algo que los necesita (p. ej. «revisá el ticket en Jira»), ContextPilot te lo va a recomendar con un botón para reactivarlo.',
        '',
      ]
    : [];
  const manual = [
    'Opción manual (en Claude Code):',
    '1. Escribí /mcp en la sesión.',
    '2. Elegí el servidor y «Disable». Se aplica a las sesiones nuevas.',
    '3. Para reactivarlo, /mcp → el servidor → «Enable».',
  ];
  return [`Servidores sin uso en esta sesión:\n${list}`, '', ...auto, ...manual].join('\n');
}
