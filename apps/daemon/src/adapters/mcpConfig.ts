import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// D-4 (R6): servidores MCP configurados localmente para Claude Code. SÓLO LECTURA: se leen los
// nombres de `mcpServers` de ~/.claude.json (global y por proyecto) y de ~/.claude/settings.json.
// Nunca se leen ni se guardan comandos, argumentos, variables de entorno ni tokens de esos servidores.

export function claudeConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.CONTEXTPILOT_CLAUDE_HOME ?? env.USERPROFILE ?? homedir();
  const cfgDir = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
  return [join(home, '.claude.json'), join(cfgDir, 'settings.json')];
}

/** Nombres de servidores MCP configurados (sin duplicados). Archivos ausentes o inválidos se ignoran. */
export function configuredMcpServers(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set<string>();
  for (const file of claudeConfigFiles(env)) {
    if (!existsSync(file)) continue;
    let j: any;
    try {
      j = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const k of Object.keys(j?.mcpServers ?? {})) names.add(k);
    for (const proj of Object.values<any>(j?.projects ?? {})) for (const k of Object.keys(proj?.mcpServers ?? {})) names.add(k);
  }
  return [...names];
}
