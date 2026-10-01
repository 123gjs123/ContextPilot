import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isMcpServerKey } from '@contextpilot/core';
import { writeAtomic } from './paths.js';

// R6 / R11: desactivar y reactivar servidores MCP de Claude Code por proyecto.
// Mecanismo: regla `permissions.deny` pelada (`mcp__<srv>`) en <cwd>/.claude/settings.local.json;
// Claude Code saca esas herramientas del contexto y recarga el archivo sin reiniciar.
// Sólo se tocan las reglas que agregó ContextPilot (registro en mcp-toggles.json): al reactivar nunca
// se quita una regla que el usuario ya tenía. Un settings.local.json inválido no se reescribe.

interface Record_ {
  /** cwd normalizado → servidor → ts de desactivación. */
  projects: Record<string, Record<string, string>>;
}

export type ToggleResult = { ok: true; servers: string[]; file: string } | { ok: false; error: string };

export function settingsLocalPath(cwd: string): string {
  return join(cwd, '.claude', 'settings.local.json');
}

function key(cwd: string): string {
  const r = resolve(cwd);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export class McpToggles {
  private rec: Record_;

  constructor(private readonly file: string) {
    this.rec = { projects: {} };
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (j && typeof j.projects === 'object') this.rec = { projects: j.projects };
    } catch {
      // sin registro previo
    }
  }

  /** Servidores que ContextPilot desactivó en esa carpeta. */
  list(cwd: string | undefined): string[] {
    if (!cwd) return [];
    return Object.keys(this.rec.projects[key(cwd)] ?? {}).sort();
  }

  disable(cwd: string, servers: string[]): ToggleResult {
    return this.apply(cwd, servers, 'disable');
  }

  enable(cwd: string, servers: string[]): ToggleResult {
    return this.apply(cwd, servers, 'enable');
  }

  private apply(cwd: string, requested: string[], op: 'disable' | 'enable'): ToggleResult {
    if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) return { ok: false, error: 'No conozco la carpeta del proyecto de esta sesión: enviá un prompt en la sesión y reintentá.' };
    const servers = [...new Set(requested)].filter(isMcpServerKey);
    if (!servers.length) return { ok: false, error: 'No hay servidores MCP válidos en la acción.' };
    const file = settingsLocalPath(cwd);
    let j: any = {};
    if (existsSync(file)) {
      try {
        j = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return { ok: false, error: `${file} no es JSON válido: no lo modifico. Corregilo y reintentá.` };
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: `${file} no tiene el formato esperado: no lo modifico.` };
    }
    const perms = j.permissions && typeof j.permissions === 'object' ? j.permissions : (j.permissions = {});
    const deny: string[] = Array.isArray(perms.deny) ? perms.deny : (perms.deny = []);
    const k = key(cwd);
    const mine = (this.rec.projects[k] ??= {});
    const changed: string[] = [];
    if (op === 'disable') {
      for (const s of servers) {
        if (!deny.includes(s)) {
          deny.push(s);
          mine[s] = new Date().toISOString();
          changed.push(s);
        }
      }
    } else {
      for (const s of servers) {
        if (!(s in mine)) continue;
        const i = deny.indexOf(s);
        if (i >= 0) deny.splice(i, 1);
        delete mine[s];
        changed.push(s);
      }
      if (!deny.length) delete perms.deny;
      if (!Object.keys(perms).length) delete j.permissions;
    }
    if (!Object.keys(mine).length) delete this.rec.projects[k];
    if (changed.length) {
      mkdirSync(dirname(file), { recursive: true });
      writeAtomic(file, `${JSON.stringify(j, null, 2)}\n`);
      this.save();
    }
    return { ok: true, servers: changed, file };
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.rec, null, 2));
  }
}
