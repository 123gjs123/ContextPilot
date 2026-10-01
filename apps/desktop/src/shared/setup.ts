// Puesta en marcha: qué falta para que ContextPilot funcione completo y cómo resolverlo. Puro: el
// proceso principal junta los hechos (CLI, login, hooks, MCP, daemon, adaptadores) y esto arma la
// lista que muestra el dashboard. Cada paso trae el comando listo para copiar.

export interface SetupFacts {
  /** Ruta del `claude` CLI o null si no se encontró. */
  claudeBin: string | null;
  /** Sesión iniciada en Claude Code (`claude auth status`); undefined = no se pudo consultar. */
  loggedIn?: boolean;
  daemonConnected: boolean;
  /** Hook de ContextPilot presente en ~/.claude/settings.json. */
  hooksInstalled: boolean;
  /** Servidor `playwright` configurado en Claude Code (~/.claude.json). */
  playwrightConfigured: boolean;
  /** Estado de conexión de Playwright visto en un chat (init del CLI), si hay. */
  playwrightStatus?: string;
  /** Health del adaptador `desktop` del daemon. */
  desktopHealth?: { status: string; detail?: string };
  /** Health del adaptador `web` (extensión). */
  webHealth?: { status: string; detail?: string };
  repoRoot: string;
}

export type SetupStatus = 'ok' | 'missing' | 'warn' | 'optional';

export interface SetupItem {
  id: string;
  label: string;
  status: SetupStatus;
  /** Obligatorio para el uso básico (monitor + chat). */
  required: boolean;
  detail: string;
  /** Comando a ejecutar en una terminal (PowerShell) para resolverlo. */
  command?: string;
}

const cd = (root: string) => `cd "${root}"; `;

export function setupItems(f: SetupFacts): SetupItem[] {
  const items: SetupItem[] = [];
  items.push(
    f.claudeBin
      ? { id: 'claude', label: 'Claude Code (CLI) instalado', status: 'ok', required: true, detail: f.claudeBin }
      : {
          id: 'claude',
          label: 'Claude Code (CLI) instalado',
          status: 'missing',
          required: true,
          detail: 'El chat y los hooks usan el `claude` CLI. Instalalo con npm (o con la extensión de VS Code).',
          command: 'npm install -g @anthropic-ai/claude-code',
        },
  );
  items.push(
    f.loggedIn === true
      ? { id: 'login', label: 'Sesión iniciada en Claude Code', status: 'ok', required: true, detail: 'El chat usa tu suscripción con este login.' }
      : {
          id: 'login',
          label: 'Sesión iniciada en Claude Code',
          status: f.claudeBin ? (f.loggedIn === false ? 'missing' : 'warn') : 'missing',
          required: true,
          detail: f.loggedIn === false ? 'No hay sesión: el chat no puede responder.' : 'No se pudo consultar el estado del login.',
          command: 'claude auth login',
        },
  );
  items.push(
    f.daemonConnected
      ? { id: 'daemon', label: 'Daemon de ContextPilot corriendo', status: 'ok', required: true, detail: '127.0.0.1:47800' }
      : {
          id: 'daemon',
          label: 'Daemon de ContextPilot corriendo',
          status: 'missing',
          required: true,
          detail: 'Sin daemon no hay monitoreo, tarjetas ni notificaciones. Arrancalo desde una terminal propia.',
          command: `${cd(f.repoRoot)}powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1`,
        },
  );
  items.push(
    f.hooksInstalled
      ? { id: 'hooks', label: 'Hooks de Claude Code', status: 'ok', required: false, detail: 'Avisos más rápidos y la regla R11 (reactivar MCP).' }
      : {
          id: 'hooks',
          label: 'Hooks de Claude Code',
          status: 'warn',
          required: false,
          detail: 'Recomendado: aceleran la lectura y habilitan R11. Sin hooks igual funciona (lee los transcripts).',
          command: `${cd(f.repoRoot)}node scripts/install-hooks.mjs`,
        },
  );
  const pw = f.playwrightStatus;
  items.push(
    f.playwrightConfigured && (!pw || pw === 'connected')
      ? { id: 'playwright', label: 'MCP de Playwright (navegador)', status: 'ok', required: false, detail: pw ? 'Conectado.' : 'Configurado; se conecta al abrir un chat.' }
      : {
          id: 'playwright',
          label: 'MCP de Playwright (navegador)',
          status: 'warn',
          required: false,
          detail: f.playwrightConfigured
            ? `Configurado pero no conecta (${pw}). Probá «claude mcp get playwright» para ver el error.`
            : 'Para tareas de navegador en el chat (abrir páginas, hacer clic, completar formularios).',
          command: f.playwrightConfigured ? 'claude mcp get playwright' : 'claude mcp add --scope user playwright -- npx @playwright/mcp@latest',
        },
  );
  const d = f.desktopHealth;
  items.push(
    d?.status === 'ok'
      ? { id: 'desktop', label: 'Claude Desktop', status: 'ok', required: false, detail: 'Sus conversaciones se leen en modo sólo lectura.' }
      : {
          id: 'desktop',
          label: 'Claude Desktop',
          status: d?.status === 'error' ? 'warn' : 'optional',
          required: false,
          detail: d?.detail ?? 'Opcional. Si está instalado, el daemon lo detecta solo.',
        },
  );
  const w = f.webHealth;
  items.push(
    w?.status === 'ok'
      ? { id: 'extension', label: 'Extensión del navegador', status: 'ok', required: false, detail: 'claude.ai, ChatGPT y Gemini en la web.' }
      : {
          id: 'extension',
          label: 'Extensión del navegador',
          status: 'optional',
          required: false,
          detail: 'Opcional, para chats en la web. Cargá apps/extension/dist como extensión descomprimida y pegá el token de %LOCALAPPDATA%\\ContextPilot\\token (ver docs/INSTALL.md §3).',
        },
  );
  return items;
}

/** Pasos obligatorios sin resolver (para el aviso en «En vivo» y abrir el panel al iniciar). */
export function missingRequired(items: SetupItem[]): SetupItem[] {
  return items.filter((i) => i.required && i.status !== 'ok');
}
