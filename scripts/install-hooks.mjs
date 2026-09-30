#!/usr/bin/env node
// CP-032 / CP-045.4: agrega (o quita) los hooks de ContextPilot en ~/.claude/settings.json.
//   node scripts/install-hooks.mjs                 instala hooks SessionStart, UserPromptSubmit, PreCompact, Stop
//   node scripts/install-hooks.mjs --statusline    además configura statusLine (no pisa una ajena sin --force)
//   node scripts/install-hooks.mjs --uninstall     quita sólo las entradas propias (hooks y statusLine)
//   --settings <ruta>  usa otro settings.json (default: $CLAUDE_CONFIG_DIR o ~/.claude)
//   --dry-run          muestra el resultado sin escribir
// Preserva hooks existentes, hace backup settings.json.cp-bak (una vez, antes del primer cambio) y es idempotente.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop'];
const here = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(here, 'hook.mjs').replace(/\\/g, '/');
const STATUS_SCRIPT = resolve(here, 'statusline.mjs').replace(/\\/g, '/');

export function hookCommand(name) {
  return `node "${HOOK_SCRIPT}" ${name}`;
}
export function statusCommand() {
  return `node "${STATUS_SCRIPT}"`;
}

/** Entrada propia: comando que invoca un hook.mjs / statusline.mjs de ContextPilot. */
export function isOwn(cmd, script = 'hook.mjs') {
  if (typeof cmd !== 'string') return false;
  const c = cmd.replace(/\\/g, '/');
  if (script === 'hook.mjs' && c.includes(HOOK_SCRIPT)) return true;
  if (script === 'statusline.mjs' && c.includes(STATUS_SCRIPT)) return true;
  return /contextpilot/i.test(c) && c.includes(`/scripts/${script}`);
}

export function settingsPath(args, env = process.env) {
  const i = args.indexOf('--settings');
  if (i >= 0 && args[i + 1]) return resolve(args[i + 1]);
  const base = env.CLAUDE_CONFIG_DIR ?? join(env.USERPROFILE ?? env.HOME ?? homedir(), '.claude');
  return join(base, 'settings.json');
}

/** Devuelve settings nuevos (función pura). */
export function apply(settings, { uninstall = false, statusline = false, force = false } = {}) {
  const s = structuredClone(settings ?? {});
  const notes = [];
  const hadHooks = 'hooks' in s;
  s.hooks ??= {};
  for (const name of HOOKS) {
    const groups = Array.isArray(s.hooks[name]) ? s.hooks[name] : [];
    // quitar las propias (para reinstalar limpio o desinstalar)
    const cleaned = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOwn(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    if (!uninstall) cleaned.push({ hooks: [{ type: 'command', command: hookCommand(name), timeout: 5 }] });
    if (cleaned.length) s.hooks[name] = cleaned;
    else delete s.hooks[name];
  }
  if (!Object.keys(s.hooks).length && !hadHooks) delete s.hooks;

  const current = s.statusLine;
  const ownStatus = current && isOwn(current.command, 'statusline.mjs');
  if (uninstall) {
    if (ownStatus) delete s.statusLine;
  } else if (statusline) {
    if (current && !ownStatus && !force) {
      notes.push('statusLine existente ajena: no se modifica (usá --force para reemplazarla)');
    } else {
      s.statusLine = { type: 'command', command: statusCommand(), padding: 0 };
    }
  }
  return { settings: s, notes };
}

function main() {
  const args = process.argv.slice(2);
  const opts = {
    uninstall: args.includes('--uninstall'),
    statusline: args.includes('--statusline'),
    force: args.includes('--force'),
  };
  const file = settingsPath(args);
  let current = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`No se pudo leer ${file}: ${e.message}. No se modifica nada.`);
      process.exit(1);
    }
  }
  const { settings, notes } = apply(current, opts);
  for (const n of notes) console.log(n);
  const before = JSON.stringify(current);
  const after = JSON.stringify(settings);
  if (before === after) {
    console.log(`Sin cambios en ${file}.`);
    return;
  }
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify(settings, null, 2));
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const bak = `${file}.cp-bak`;
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
  const tmp = `${file}.cp-tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, file);
  console.log(`${opts.uninstall ? 'Hooks quitados de' : 'Hooks instalados en'} ${file}${existsSync(bak) ? ` (backup: ${bak})` : ''}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
