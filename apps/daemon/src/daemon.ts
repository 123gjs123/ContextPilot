import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { aggregateTeam, projectPlan, R10, serversMentioned, RuleEngine, type AdapterHealth, type Projection, type Provider } from '@contextpilot/core';
import { createClaudeCodeAdapter, createCodexAdapter, defaultClaudeProjectsDir, defaultCodexSessionsDir } from './adapters/cli.js';
import { DesktopStoreAdapter } from './adapters/desktop/store.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { configuredMcpServers } from './adapters/mcpConfig.js';
import { PERCENT_PLAN, PlanUsageAdapter } from './adapters/planUsage.js';
import type { JsonlAdapter } from './adapters/jsonl.js';
import {
  adapterEnabled,
  defaultDaemonConfig,
  loadConfig,
  mergeDaemonConfig,
  migrateConfig,
  saveConfig,
  validateConfigPatch,
  type DaemonConfig,
} from './config.js';
import { findClaudeBin, handoff, type HandoffResult } from './handoff.js';
import { HealthRegistry } from './health.js';
import { createLogger, type Logger } from './log.js';
import { encodeProjectDir, ensureDirs, loadOrCreateToken, resolvePaths, type DaemonPaths } from './paths.js';
import { McpToggles, type ToggleResult } from './mcpToggle.js';
import { Pipeline } from './pipeline.js';
import { Proxy, upstreamsFromEnv, type ProxyOptions } from './proxy.js';
import { createApp, redactPrompt, type ServerMsg } from './server.js';
import { Storage } from './storage.js';

// Orquestación del daemon: rutas, token, config, storage, pipeline, adaptadores, proxy y servidor.

export const VERSION = '0.1.0';
const DAY = 86_400_000;
const BURN_MS = 15 * 60_000;
/** D-22: cada cuánto se reevalúan las reglas de cuenta (R10) sin depender de eventos de sesión. */
const ACCOUNT_EVAL_MS = 60_000;
const PROVIDERS: Provider[] = ['anthropic', 'openai', 'google'];

/** D-5: ritmo y proyección por proveedor (GET /stats `burn`, GET /account). */
export interface ProviderBurn {
  provider: Provider;
  /**
   * Tokens efectivos por minuto de todas las sesiones del proveedor, media móvil de 15 min (CP-018.1).
   * D-21: input + cacheWrite + output + 0,1 × cacheRead.
   */
  tokensPerMin: number;
  tokensPerHour: number;
  /** D-21: lo mismo sin ponderar la lectura de caché (transparencia). */
  rawTokensPerMin: number;
  /** Proyección contra las ventanas del plan (unidades del plan: tokens o % si viene de plan-usage). */
  projections: Projection[];
  /** 'plan-usage' = serie exacta de Claude Desktop; 'local' = turnos observados por ContextPilot. */
  source: 'plan-usage' | 'local' | 'none';
}

export interface DaemonOptions {
  home: string;
  port: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  upstreams?: Record<Provider, string>;
  claudeBin?: () => string | null;
  /** Intervalos de los tailers (tests). */
  rescanMs?: number;
  rootRetryMs?: number;
  /** Sin archivo de log (tests). */
  quiet?: boolean;
  /** Tests (D-22): intervalo de la evaluación de reglas de cuenta. */
  accountEvalMs?: number;
  /** Tests (D-10): extractor de uso del proxy reemplazable. */
  proxyExtractorFor?: ProxyOptions['extractorFor'];
  echoLog?: boolean;
}

export class Daemon {
  readonly paths: DaemonPaths;
  readonly token: string;
  readonly log: Logger;
  readonly health = new HealthRegistry();
  readonly version = VERSION;
  config: DaemonConfig;
  storage!: Storage;
  pipeline!: Pipeline;
  proxy!: Proxy;
  server!: Server;
  port = 0;
  private broadcast: (m: ServerMsg) => void = () => {};
  private claude: JsonlAdapter | null = null;
  private codex: JsonlAdapter | null = null;
  private gemini: GeminiAdapter | null = null;
  planUsage: PlanUsageAdapter | null = null;
  desktopStore: DesktopStoreAdapter | null = null;
  private geminiPath = '';
  private retentionTimer: NodeJS.Timeout | null = null;
  private accountTimer: NodeJS.Timeout | null = null;
  private env: NodeJS.ProcessEnv;
  private closeWss: () => void = () => {};
  readonly handoffCwd: string;
  private readonly mcpToggles: McpToggles;
  /** R6/R11: sesión → cwd informado por los hooks (sólo memoria). */
  private readonly cwdBySession = new Map<string, string>();

  constructor(private o: DaemonOptions) {
    this.env = o.env ?? process.env;
    this.paths = resolvePaths(o.home);
    ensureDirs(this.paths);
    this.log = createLogger(o.quiet ? null : this.paths.logs, o.echoLog);
    this.token = loadOrCreateToken(this.paths);
    const loaded = loadConfig(this.paths.config);
    this.config = loaded.config;
    if (loaded.error) {
      this.health.set('config', { status: 'error', detail: loaded.error });
      this.log.warn(loaded.error);
    }
    this.handoffCwd = join(this.paths.home, 'handoff');
    this.mcpToggles = new McpToggles(join(this.paths.home, 'mcp-toggles.json'));
  }

  /** R6/R11: carpeta de trabajo de la sesión (hooks de Claude Code o, si no, el transcript). Sólo memoria. */
  cwdFor(sessionId: string): string | undefined {
    return this.cwdBySession.get(sessionId) ?? this.claude?.metaFor(sessionId)?.cwd;
  }

  /** R6/R11: desactiva o reactiva servidores MCP en el proyecto de la sesión y refresca su tarjeta. */
  toggleMcp(sessionId: string, servers: string[], op: 'disable' | 'enable'): ToggleResult & { project?: string } {
    const cwd = this.cwdFor(sessionId);
    if (!cwd) return { ok: false, error: 'No conozco la carpeta del proyecto de esta sesión: enviá un prompt en la sesión y reintentá.' };
    const r = op === 'disable' ? this.mcpToggles.disable(cwd, servers) : this.mcpToggles.enable(cwd, servers);
    if (r.ok) {
      this.log.info(`MCP ${op}: ${r.servers.join(', ') || '(sin cambios)'} en ${r.file}`);
      this.pipeline.refreshSession(sessionId);
    }
    return r;
  }

  /** R6/R11: servidores desactivados por ContextPilot en el proyecto de la sesión. */
  mcpDisabled(sessionId: string): string[] {
    return this.mcpToggles.list(this.cwdFor(sessionId));
  }

  get claudeProjectsDir(): string {
    return this.o.claudeProjectsDir ?? defaultClaudeProjectsDir(this.env);
  }

  async start(): Promise<void> {
    this.storage = await Storage.open(this.paths.db);
    const purged = this.storage.purge(this.config.daemon.retentionDays);
    if (purged) this.log.info(`retención: ${purged} turnos purgados`);
    this.retentionTimer = setInterval(() => this.storage.purge(this.config.daemon.retentionDays), DAY);
    this.retentionTimer.unref();

    const engine = new RuleEngine(this.effectiveConfig());
    this.pipeline = new Pipeline(this.storage, engine, this.health, () => this.config, this.log, {
      planUsage: (p) => (p === 'anthropic' ? this.planUsage?.usageWindow() : undefined),
      // D-2: foco de /compact desde el parser en memoria del transcript de la sesión.
      focusFor: (sid) => this.claude?.focusFor(sid),
      // CP-061: nombre legible (proyecto + título) desde los parsers en memoria; nunca se persiste el título.
      metaFor: (sid) => {
        const m = this.claude?.metaFor(sid) ?? this.codex?.metaFor(sid);
        const mcpDisabled = this.mcpToggles.list(this.cwdFor(sid));
        return mcpDisabled.length ? { ...m, mcpDisabled } : m;
      },
    });
    this.proxy = new Proxy({
      env: this.env,
      extractorFor: this.o.proxyExtractorFor,
      upstreams: this.o.upstreams ?? upstreamsFromEnv(this.env),
      pipeline: this.pipeline,
      health: this.health,
      log: this.log,
      enabled: () => adapterEnabled(this.config, 'proxy'),
    });

    const app = createApp(this);
    this.server = app.server;
    this.broadcast = app.broadcast;
    this.closeWss = () => {
      for (const c of app.wss.clients) c.terminate();
      app.wss.close();
    };
    this.pipeline.on('session', (v) => this.broadcast({ type: 'session', data: v }));
    this.pipeline.on('suggestion', (s) => this.broadcast({ type: 'suggestion', data: s }));
    this.pipeline.on('cleared', (c) => this.broadcast({ type: 'suggestion-cleared', data: c }));
    this.health.on('change', () => this.broadcast({ type: 'health', data: this.healthList() }));

    await new Promise<void>((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(this.o.port, this.o.host ?? '127.0.0.1', () => {
        this.server.off('error', rej);
        res();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.log.info(`daemon ${VERSION} escuchando en 127.0.0.1:${this.port}`);
    this.health.set('hooks', { status: 'no-data', detail: 'sin hooks recibidos' });
    this.health.set('web', { status: 'no-data', detail: 'sin eventos de la extensión' });
    this.health.set('desktop', { status: 'no-data', detail: 'sin eventos de desktop' });
    this.refreshSecurityHealth();
    this.refreshR6Health();
    this.reconcileAdapters();
    // D-22: R10 (cuenta) se evalúa también por tiempo: con uso sólo en Desktop/web, plan-usage avanza
    // sin eventos de sesión. Primera evaluación al terminar el escaneo inicial (replay en seco, D-19).
    this.accountTimer = setInterval(() => this.evaluateAccounts(), this.o.accountEvalMs ?? ACCOUNT_EVAL_MS);
    this.accountTimer.unref();
    void this.ready().then(() => this.evaluateAccounts());
  }

  /** D-22: reevalúa las reglas de cuenta de todos los proveedores con plan. */
  evaluateAccounts(): void {
    if (!this.pipeline || !this.storage) return;
    try {
      this.pipeline.evaluateAccounts();
    } catch (e) {
      this.log.warn(`evaluación de reglas de cuenta: ${(e as Error).message}`);
    }
  }

  /** D-9: sin `allowedExtensionIds`, cualquier extensión con el token es aceptada: aviso en log y health. */
  refreshSecurityHealth(): void {
    const ids = this.config.daemon.allowedExtensionIds ?? [];
    if (ids.length) {
      this.health.set('origin', { status: 'ok', detail: `extensiones permitidas: ${ids.length}` });
    } else {
      this.health.set('origin', {
        status: 'ok',
        detail: 'aviso: allowedExtensionIds vacío, se acepta cualquier chrome-extension:// con el token (H-5)',
      });
      this.log.warn('daemon.allowedExtensionIds vacío: se acepta cualquier extensión con el token (configurar el id, H-5)');
    }
  }

  /**
   * D-4 / CP-015.3: R6 sólo evalúa donde hay definiciones. Proxy = exacto (array `tools`);
   * Claude Code = inventario MCP estimado del transcript; Codex/Gemini CLI = no evaluable.
   */
  refreshR6Health(): void {
    let configured = 0;
    try {
      configured = configuredMcpServers(this.env).length;
    } catch {
      configured = 0;
    }
    this.health.set('rule-R6', {
      status: 'ok',
      detail: `proxy: exacto; claude-code: ≈ inventario MCP del transcript (${configured} servidores en config local); codex/gemini-cli: no evaluable (sin definiciones)`,
    });
  }

  /** D-5: ritmo (15 min) y proyección de cada proveedor con consumo o plan. */
  burnByProvider(now = Date.now()): ProviderBurn[] {
    const out: ProviderBurn[] = [];
    for (const provider of PROVIDERS) {
      const recent = this.storage.usagePoints(provider, now - BURN_MS);
      const tokens = recent.reduce((s, p) => s + p.tokens, 0);
      const raw = recent.reduce((s, p) => s + p.raw, 0);
      const plan = this.pipeline.engine.planFor(provider);
      const series = this.pipeline.usageWindowFor(provider, now);
      // Misma ventana de ritmo y amortiguación que R10 (D-5): /account y la sugerencia coinciden.
      const th = this.pipeline.engine.thresholdsFor(R10, provider);
      const projections = series
        ? projectPlan(plan, (k) => series.byWindow?.[k] ?? series.points, now, (th.rateWindowMin ?? 60) * 60_000, th.rateDamping)
        : [];
      if (!tokens && !projections.length) continue;
      const fromPlanUsage = provider === 'anthropic' && !!this.planUsage?.fresh(now);
      out.push({
        provider,
        tokensPerMin: Math.round(tokens / 15),
        tokensPerHour: Math.round(tokens * 4),
        rawTokensPerMin: Math.round(raw / 15),
        projections,
        source: projections.length ? (fromPlanUsage ? 'plan-usage' : 'local') : 'none',
      });
    }
    return out;
  }

  /** Espera el escaneo inicial de los tailers (replay incluido). */
  async ready(): Promise<void> {
    await Promise.all([this.claude?.whenReady(), this.codex?.whenReady(), this.gemini?.whenReady()]);
  }

  /** CP-054.2: arranca/detiene adaptadores según config (en caliente). */
  reconcileAdapters(): void {
    const common = {
      recentMs: this.config.daemon.recentMs,
      pipeline: this.pipeline,
      storage: this.storage,
      health: this.health,
      log: this.log,
      rescanMs: this.o.rescanMs,
      rootRetryMs: this.o.rootRetryMs,
    };
    const on = (n: string) => adapterEnabled(this.config, n);

    if (on('claude-code') && !this.claude) {
      this.claude = createClaudeCodeAdapter({
        ...common,
        root: this.claudeProjectsDir,
        // El traspaso corre `claude -p` en esta carpeta: su transcript no es una sesión del usuario.
        ignoreProjects: [encodeProjectDir(this.handoffCwd)],
      });
      void this.claude.start();
    } else if (!on('claude-code') && this.claude) {
      this.claude.stop();
      this.claude = null;
    }
    if (on('codex') && !this.codex) {
      this.codex = createCodexAdapter({ ...common, root: this.o.codexSessionsDir ?? defaultCodexSessionsDir(this.env) });
      void this.codex.start();
    } else if (!on('codex') && this.codex) {
      this.codex.stop();
      this.codex = null;
    }
    const gPath = this.config.daemon.geminiOutfile;
    if (this.gemini && (!on('gemini-cli') || gPath !== this.geminiPath)) {
      this.gemini.stop();
      this.gemini = null;
    }
    if (on('gemini-cli') && !this.gemini) {
      this.geminiPath = gPath;
      this.gemini = new GeminiAdapter({ ...common, outfile: gPath });
      void this.gemini.start();
    }
    if (on('claude-plan-usage') && !this.planUsage) {
      this.planUsage = new PlanUsageAdapter({
        health: this.health,
        log: this.log,
        env: this.env,
        onChange: () => this.pipeline.engine.setConfig(this.effectiveConfig()),
        onSamples: () => this.evaluateAccounts(),
      });
      this.planUsage.start();
    } else if (!on('claude-plan-usage') && this.planUsage) {
      this.planUsage.stop();
      this.planUsage = null;
      this.pipeline.engine.setConfig(this.effectiveConfig());
    }
    // H-1: turnos de Claude Desktop desde su store local (sólo lectura).
    if (on('desktop') && !this.desktopStore) {
      this.desktopStore = new DesktopStoreAdapter({ pipeline: this.pipeline, storage: this.storage, health: this.health, log: this.log, env: this.env, recentMs: this.config.daemon.recentMs });
      this.desktopStore.start();
    } else if (!on('desktop') && this.desktopStore) {
      this.desktopStore.stop();
      this.desktopStore = null;
    }
    for (const n of ['claude-code', 'codex', 'gemini-cli', 'hooks', 'proxy', 'web', 'desktop', 'claude-plan-usage']) {
      if (!on(n)) this.health.set(n, { status: 'disabled', detail: 'deshabilitado en config' });
      else if (this.health.get(n)?.status === 'disabled') this.health.set(n, { status: 'no-data', detail: 'habilitado' });
    }
  }

  /**
   * Config que ve el motor: la del usuario, salvo que Claude Desktop informe uso del plan (dato
   * exacto del proveedor): entonces R10 de anthropic proyecta sobre esa serie en unidades de %.
   */
  effectiveConfig(): DaemonConfig {
    if (!this.planUsage?.fresh()) return this.config;
    return { ...this.config, plans: [...this.config.plans.filter((p) => p.provider !== 'anthropic'), PERCENT_PLAN] };
  }

  healthList(): AdapterHealth[] {
    const extraCa = !!this.env.NODE_EXTRA_CA_CERTS;
    const proxyEnv = !!(this.env.HTTPS_PROXY ?? this.env.https_proxy);
    // CP-002.3: env.extraCa=true cuando corre bajo with-ca.
    return [
      ...this.health.list(),
      { name: 'env', status: 'ok', detail: `extraCa=${extraCa}; httpsProxy=${proxyEnv}; version=${VERSION}` },
    ];
  }

  /** Hooks de Claude Code: registran sesión ↔ transcript; el tailer sigue siendo la fuente primaria. */
  onHook(name: string, body: any, known: boolean): void {
    if (!known) {
      const n = this.health.count('hooks.unknown');
      this.health.set('hooks', { detail: `hooks desconocidos: ${n}` });
      return;
    }
    if (!adapterEnabled(this.config, 'hooks')) return;
    this.health.seen('hooks');
    const sid = typeof body?.session_id === 'string' ? body.session_id : undefined;
    const path = typeof body?.transcript_path === 'string' ? body.transcript_path : undefined;
    if (sid && path) {
      this.storage.setTranscript(sid, path, 'claude-code');
      if (this.claude) {
        const rel = relative(this.claudeProjectsDir, resolve(path));
        const inside = !rel.startsWith('..') && !isAbsolute(rel);
        if (inside) this.claude.poke(resolve(path));
        else void this.claude.tailer.discover(resolve(path), false);
      }
    }
    if (sid && typeof body?.cwd === 'string' && isAbsolute(body.cwd)) this.cwdBySession.set(sid, body.cwd);
    // R11: ¿el prompt pide algo de un MCP que desactivamos? El texto se usa acá y se descarta.
    if (name === 'UserPromptSubmit' && sid && typeof body?.prompt === 'string') {
      const needed = serversMentioned(body.prompt, this.mcpToggles.list(this.cwdFor(sid)));
      if (needed.length) this.pipeline.promptSignal(sid, { mcpNeeded: needed });
    }
    // RNF-01: el texto del prompt sólo se persiste con opt-in de la fuente.
    if (name === 'UserPromptSubmit' && sid && this.config.storeContent['claude-code']) {
      const text = redactPrompt(body?.prompt);
      if (text) this.storage.insertContent(sid, 'claude-code', 'user', text);
    }
  }

  ingestOtlp(body: unknown): void {
    if (!this.gemini || !adapterEnabled(this.config, 'gemini-cli')) return;
    this.gemini.ingestOtlp(body);
  }

  handoff(sessionId: string, content?: string): Promise<HandoffResult> {
    mkdirSync(this.handoffCwd, { recursive: true });
    return handoff(
      {
        transcriptFor: (id) => this.storage.getTranscript(id),
        sourceFor: (id) => this.pipeline.getSession(id)?.source,
        claudeBin: this.o.claudeBin ?? (() => findClaudeBin(this.env)),
        model: () => this.config.daemon.handoffModel,
        cwd: this.handoffCwd,
        recordUsage: (m, i, o, c) => this.storage.recordAdvisorUsage(m, i, o, c),
        log: this.log,
      },
      { sessionId, content },
    );
  }

  /** PUT /config (merge), POST /config/import (replace) o dry-run. */
  updateConfig(body: unknown, mode: 'merge' | 'replace' | 'dry-run'): { config: DaemonConfig } | { error: string } {
    const migrated = migrateConfig(body);
    const err = validateConfigPatch(migrated);
    if (err) return { error: err };
    const base = mode === 'merge' ? this.config : defaultDaemonConfig();
    const next = mergeDaemonConfig(base, migrated);
    if (mode === 'dry-run') return { config: next };
    const retentionChanged = next.daemon.retentionDays !== this.config.daemon.retentionDays;
    this.config = next;
    saveConfig(this.paths.config, next);
    this.pipeline.engine.setConfig(this.effectiveConfig());
    this.refreshSecurityHealth();
    if (this.health.get('config')?.status === 'error') this.health.set('config', { status: 'ok', detail: 'config válida' });
    this.reconcileAdapters();
    if (retentionChanged) this.storage.purge(next.daemon.retentionDays);
    return { config: next };
  }

  /** CP-057: agregado anónimo (sin ids, hashes ni rutas; buckets < 5 sesiones suprimidos en el core). */
  teamExport(fromMs: number, toMs: number): unknown {
    const rows = this.storage.teamRows(fromMs, toMs);
    return aggregateTeam({
      sessions: rows.sessions,
      suggestions: rows.suggestions.map((s) => ({
        sessionId: s.sessionId,
        ruleId: s.ruleId,
        createdAt: s.createdAt,
        feedback: s.feedback ?? (s.status === 'expired' ? 'expired' : null),
        estimatedSavingTokens: s.estimatedSavingTokens,
      })),
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });
  }

  async close(): Promise<void> {
    this.claude?.stop();
    this.codex?.stop();
    this.gemini?.stop();
    this.planUsage?.stop();
    this.desktopStore?.stop();
    this.claude = this.codex = null;
    this.gemini = null;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.accountTimer) clearInterval(this.accountTimer);
    this.accountTimer = null;
    this.pipeline?.dispose();
    this.health.dispose();
    this.proxy?.close();
    this.closeWss();
    if (this.server?.listening) {
      this.server.closeAllConnections();
      await new Promise<void>((r) => this.server.close(() => r()));
    }
    this.storage?.close();
  }
}

export async function startDaemon(o: DaemonOptions): Promise<Daemon> {
  const d = new Daemon(o);
  await d.start();
  return d;
}
