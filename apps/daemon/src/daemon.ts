import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { aggregateTeam, RuleEngine, type AdapterHealth, type Provider } from '@contextpilot/core';
import { createClaudeCodeAdapter, createCodexAdapter, defaultClaudeProjectsDir, defaultCodexSessionsDir } from './adapters/cli.js';
import { GeminiAdapter } from './adapters/gemini.js';
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
import { Pipeline } from './pipeline.js';
import { Proxy, upstreamsFromEnv } from './proxy.js';
import { createApp, redactPrompt, type ServerMsg } from './server.js';
import { Storage } from './storage.js';

// Orquestación del daemon: rutas, token, config, storage, pipeline, adaptadores, proxy y servidor.

export const VERSION = '0.1.0';
const DAY = 86_400_000;

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
  private geminiPath = '';
  private retentionTimer: NodeJS.Timeout | null = null;
  private env: NodeJS.ProcessEnv;
  private closeWss: () => void = () => {};
  readonly handoffCwd: string;

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
    this.pipeline = new Pipeline(this.storage, engine, this.health, () => this.config, this.log, (p) =>
      p === 'anthropic' ? this.planUsage?.usageWindow() : undefined,
    );
    this.proxy = new Proxy({
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
    this.reconcileAdapters();
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
      });
      this.planUsage.start();
    } else if (!on('claude-plan-usage') && this.planUsage) {
      this.planUsage.stop();
      this.planUsage = null;
      this.pipeline.engine.setConfig(this.effectiveConfig());
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
    this.claude = this.codex = null;
    this.gemini = null;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
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
