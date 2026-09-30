import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, mergeConfig, type Config, type PlanProfile, type Provider, type Source } from '@contextpilot/core';
import { writeAtomic } from './paths.js';

// CP-054..CP-056: configuración persistida en config.json, mezclada sobre defaultConfig del core.

export const CONFIG_SCHEMA_VERSION = 1;

/** Ajustes propios del daemon (superconjunto de Config; las UIs los ignoran si no los conocen). */
export interface DaemonSettings {
  retentionDays: number;
  /** Ruta del telemetry.outfile de Gemini CLI. */
  geminiOutfile: string;
  /** Umbral (ms) para considerar «reciente» un transcript al arrancar y reprocesarlo. */
  recentMs: number;
  /** Modelo para el traspaso vía CLI de Claude Code. */
  handoffModel: string;
  /**
   * D-9 / CP-022.4: ids de extensión aceptados en `Origin: chrome-extension://<id>`. Vacío = cualquier
   * extensión con el token (permisivo, con aviso en log y /health) hasta la decisión humana H-5.
   */
  allowedExtensionIds: string[];
}

export type DaemonConfig = Config & { schemaVersion?: number; daemon: DaemonSettings };

export const ADAPTERS = ['claude-code', 'codex', 'gemini-cli', 'hooks', 'proxy', 'web', 'desktop', 'claude-plan-usage'] as const;
const SOURCES: Source[] = ['claude-code', 'codex', 'gemini-cli', 'proxy', 'web', 'desktop'];
const PROVIDERS: Provider[] = ['anthropic', 'openai', 'google'];

export function defaultDaemonConfig(): DaemonConfig {
  const base = defaultConfig();
  return {
    ...base,
    adapters: Object.fromEntries(ADAPTERS.map((a) => [a, { enabled: true }])),
    storeContent: Object.fromEntries(SOURCES.map((s) => [s, false])),
    schemaVersion: CONFIG_SCHEMA_VERSION,
    daemon: {
      retentionDays: 30,
      geminiOutfile: join(homedir(), '.gemini', 'telemetry.log'),
      recentMs: 30 * 60_000,
      handoffModel: 'haiku',
      allowedExtensionIds: [],
    },
  };
}

/** Valida un parche de configuración. Devuelve el mensaje de error o null. */
export function validateConfigPatch(p: unknown): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'config: se esperaba un objeto';
  const c = p as Record<string, any>;
  if (c.rules !== undefined) {
    if (typeof c.rules !== 'object' || c.rules === null) return 'rules: se esperaba un objeto';
    for (const [id, r] of Object.entries<any>(c.rules)) {
      if (!r || typeof r !== 'object') return `rules.${id}: se esperaba un objeto`;
      if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return `rules.${id}.enabled: booleano`;
      if (r.cooldownMs !== undefined && !(typeof r.cooldownMs === 'number' && r.cooldownMs >= 0)) return `rules.${id}.cooldownMs: número >= 0`;
      if (r.thresholds !== undefined) {
        if (typeof r.thresholds !== 'object' || r.thresholds === null) return `rules.${id}.thresholds: objeto`;
        for (const [k, v] of Object.entries(r.thresholds)) {
          if (typeof v !== 'number' || !Number.isFinite(v)) return `rules.${id}.thresholds.${k}: número`;
        }
      }
    }
  }
  if (c.providerOverrides !== undefined) {
    if (typeof c.providerOverrides !== 'object' || c.providerOverrides === null) return 'providerOverrides: objeto';
    for (const [prov, rules] of Object.entries<any>(c.providerOverrides)) {
      if (!PROVIDERS.includes(prov as Provider)) return `providerOverrides.${prov}: proveedor desconocido`;
      for (const [rid, th] of Object.entries<any>(rules ?? {})) {
        for (const [k, v] of Object.entries(th ?? {})) {
          if (typeof v !== 'number') return `providerOverrides.${prov}.${rid}.${k}: número`;
        }
      }
    }
  }
  if (c.adapters !== undefined) {
    if (typeof c.adapters !== 'object' || c.adapters === null) return 'adapters: objeto';
    for (const [a, v] of Object.entries<any>(c.adapters)) {
      if (!v || typeof v.enabled !== 'boolean') return `adapters.${a}.enabled: booleano`;
    }
  }
  if (c.plans !== undefined) {
    if (!Array.isArray(c.plans)) return 'plans: arreglo';
    for (const [i, pl] of (c.plans as PlanProfile[]).entries()) {
      const err = validatePlan(pl);
      if (err) return `plans[${i}].${err}`;
    }
  }
  if (c.storeContent !== undefined) {
    if (typeof c.storeContent !== 'object' || c.storeContent === null) return 'storeContent: objeto';
    for (const [s, v] of Object.entries(c.storeContent)) {
      if (!SOURCES.includes(s as Source)) return `storeContent.${s}: fuente desconocida`;
      if (typeof v !== 'boolean') return `storeContent.${s}: booleano`;
    }
  }
  if (c.maxVisiblePerSession !== undefined && !(Number.isInteger(c.maxVisiblePerSession) && c.maxVisiblePerSession >= 1)) {
    return 'maxVisiblePerSession: entero >= 1';
  }
  if (c.daemon !== undefined) {
    const d = c.daemon;
    if (typeof d !== 'object' || d === null) return 'daemon: objeto';
    if (d.retentionDays !== undefined && !(typeof d.retentionDays === 'number' && d.retentionDays >= 1)) return 'daemon.retentionDays: número >= 1';
    if (d.geminiOutfile !== undefined && typeof d.geminiOutfile !== 'string') return 'daemon.geminiOutfile: texto';
    if (d.recentMs !== undefined && typeof d.recentMs !== 'number') return 'daemon.recentMs: número';
    if (d.handoffModel !== undefined && typeof d.handoffModel !== 'string') return 'daemon.handoffModel: texto';
    if (
      d.allowedExtensionIds !== undefined &&
      !(Array.isArray(d.allowedExtensionIds) && d.allowedExtensionIds.every((x: unknown) => typeof x === 'string' && /^[a-p]{32}$/.test(x)))
    ) {
      return 'daemon.allowedExtensionIds: arreglo de ids de extensión (32 letras a-p)';
    }
  }
  return null;
}

/** CP-055: perfil de plan válido. */
export function validatePlan(p: any): string | null {
  if (!p || typeof p !== 'object') return 'objeto';
  if (!PROVIDERS.includes(p.provider)) return 'provider';
  if (p.kind !== 'api' && p.kind !== 'subscription') return 'kind';
  for (const k of ['windowMs', 'windowBudgetTokens', 'dailyBudgetUsd', 'pricePerMTokIn', 'pricePerMTokOut']) {
    if (p[k] !== undefined && !(typeof p[k] === 'number' && p[k] >= 0)) return k;
  }
  if (p.windows !== undefined) {
    // CP-055.1 / D-15: `windows: [{hours: 5, limit}, {days: 7, limit}]`.
    if (!Array.isArray(p.windows) || !p.windows.length) return 'windows: arreglo no vacío';
    for (const [i, w] of (p.windows as any[]).entries()) {
      if (!w || typeof w !== 'object') return `windows[${i}]`;
      const hasH = typeof w.hours === 'number' && w.hours > 0;
      const hasD = typeof w.days === 'number' && w.days > 0;
      if (!hasH && !hasD) return `windows[${i}].hours/days`;
      if (!(typeof w.limit === 'number' && w.limit > 0)) return `windows[${i}].limit`;
    }
  }
  if (p.kind === 'subscription' && !p.windows && (!p.windowMs || !p.windowBudgetTokens)) return 'windowMs/windowBudgetTokens o windows';
  if (p.kind === 'api' && (!p.dailyBudgetUsd || !p.pricePerMTokIn)) return 'dailyBudgetUsd/pricePerMTokIn';
  return null;
}

export function mergeDaemonConfig(base: DaemonConfig, patch: Partial<DaemonConfig> | undefined): DaemonConfig {
  if (!patch) return base;
  const merged = mergeConfig(base, patch) as DaemonConfig;
  merged.daemon = { ...base.daemon, ...(patch.daemon ?? {}) };
  merged.schemaVersion = CONFIG_SCHEMA_VERSION;
  return merged;
}

/** Migra versiones anteriores del esquema (hoy sólo v0 = sin schemaVersion ni bloque daemon). */
export function migrateConfig(raw: any): Partial<DaemonConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const out = { ...raw };
  // v0 usaba contentOptIn (backlog CP-054) en lugar de storeContent.
  if (out.contentOptIn && !out.storeContent) out.storeContent = out.contentOptIn;
  delete out.contentOptIn;
  delete out.schemaVersion;
  return out;
}

export interface LoadedConfig {
  config: DaemonConfig;
  error?: string;
}

/** Copia de la última config válida (CP-054.4 / D-15), junto a config.json. */
export function lastValidPath(file: string): string {
  return `${file}.last-valid`;
}

function readValid(file: string, base: DaemonConfig): { config?: DaemonConfig; error?: string } {
  try {
    const raw = migrateConfig(JSON.parse(readFileSync(file, 'utf8')));
    const err = validateConfigPatch(raw);
    if (err) return { error: `inválido: ${err}` };
    return { config: mergeDaemonConfig(base, raw) };
  } catch (e) {
    return { error: `ilegible: ${(e as Error).message}` };
  }
}

/**
 * CP-054.4 / D-15: config inválida en disco → se usa la ÚLTIMA VÁLIDA (`config.json.last-valid`, que
 * se escribe en cada carga o guardado correcto) y health lo informa; sin copia válida, los defaults.
 * El archivo inválido no se pisa: el usuario puede corregirlo.
 */
export function loadConfig(file: string): LoadedConfig {
  const base = defaultDaemonConfig();
  if (!existsSync(file)) {
    writeAtomic(file, JSON.stringify(base, null, 2));
    return { config: base };
  }
  const r = readValid(file, base);
  if (r.config) {
    writeAtomic(lastValidPath(file), JSON.stringify(r.config, null, 2));
    return { config: r.config };
  }
  const backup = existsSync(lastValidPath(file)) ? readValid(lastValidPath(file), base).config : undefined;
  const using = backup ? 'se usa la última válida' : 'se usan los valores por defecto';
  return { config: backup ?? base, error: `config.json ${r.error} (${using})` };
}

export function saveConfig(file: string, c: DaemonConfig): void {
  writeAtomic(file, JSON.stringify(c, null, 2));
  writeAtomic(lastValidPath(file), JSON.stringify(c, null, 2));
}

export function adapterEnabled(c: DaemonConfig, name: string): boolean {
  return c.adapters[name]?.enabled !== false;
}
