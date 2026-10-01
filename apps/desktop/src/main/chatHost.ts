import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  addUserMessage,
  applyCliEvent,
  cliArgs,
  encodeProjectDir,
  interruptLine,
  messagesFromTranscript,
  newChatState,
  permissionLine,
  userLine,
  type ChatState,
} from '../shared/chat.js';

// Chat de ContextPilot: un proceso `claude` (CLI oficial, con el login del usuario) por
// conversación, en modo stream-json. ContextPilot guarda sólo metadatos (id, carpeta, modelo, id de
// sesión, fechas) en chats.json; el texto vive en memoria y se reconstruye del transcript de Claude
// Code al reabrir. Las sesiones son sesiones de Claude Code: el daemon las monitorea como cualquier
// otra (tarjeta, reglas, hooks).

export interface ChatRecord {
  id: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

interface Runtime {
  rec: ChatRecord;
  state: ChatState;
  proc?: ChildProcess;
  buf: string;
  stderr: string;
  loaded: boolean;
  timer?: NodeJS.Timeout;
}

export interface ChatHostOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Ejecutable del CLI (tests); por defecto se busca. */
  claudeBin?: string | null;
  /** Argumentos antepuestos (tests: `node fake-cli.mjs`). */
  prefixArgs?: string[];
  onUpdate: (s: ChatState) => void;
  onList: (list: ChatRecord[]) => void;
}

/** Busca el `claude` CLI: binario nativo de la extensión de VS Code o el del PATH. */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CONTEXTPILOT_CLAUDE_BIN) return existsSync(env.CONTEXTPILOT_CLAUDE_BIN) ? env.CONTEXTPILOT_CLAUDE_BIN : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    for (const ext of exts) {
      const f = dir && join(dir, `claude${ext}`);
      try {
        if (f && existsSync(f) && statSync(f).isFile()) return f;
      } catch {
        // seguir
      }
    }
  }
  const extDir = join(env.USERPROFILE ?? homedir(), '.vscode', 'extensions');
  try {
    const dirs = readdirSync(extDir).filter((d) => d.startsWith('anthropic.claude-code-')).sort().reverse();
    for (const d of dirs) {
      const f = join(extDir, d, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (existsSync(f)) return f;
    }
  } catch {
    // sin extensión
  }
  return null;
}

export class ChatHost {
  private chats = new Map<string, Runtime>();
  private readonly file: string;
  private seq = 0;

  constructor(private o: ChatHostOptions) {
    this.file = join(o.home, 'chats.json');
    for (const rec of this.readStore()) this.chats.set(rec.id, { rec, state: newChatState(rec.id, rec.cwd, rec.model, rec.sessionId), buf: '', stderr: '', loaded: false });
  }

  list(): ChatRecord[] {
    return [...this.chats.values()].map((r) => r.rec).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(cwd: string, model?: string): ChatState {
    const now = new Date().toISOString();
    const rec: ChatRecord = { id: randomUUID(), cwd, model, createdAt: now, updatedAt: now };
    const rt: Runtime = { rec, state: newChatState(rec.id, cwd, model), buf: '', stderr: '', loaded: true };
    this.chats.set(rec.id, rt);
    this.save();
    return rt.state;
  }

  /** Estado de un chat; la primera vez reconstruye el historial desde el transcript. */
  open(id: string): ChatState | undefined {
    const rt = this.chats.get(id);
    if (!rt) return undefined;
    if (!rt.loaded) {
      rt.loaded = true;
      if (rt.rec.sessionId) rt.state.messages = this.history(rt.rec);
    }
    return rt.state;
  }

  send(id: string, text: string): { ok: boolean; message: string } {
    const rt = this.chats.get(id);
    if (!rt) return { ok: false, message: 'Chat inexistente' };
    const t = text.trim();
    if (!t) return { ok: false, message: 'Mensaje vacío' };
    if (rt.state.status === 'running' && !rt.proc) rt.state.status = 'idle';
    if (!rt.proc) {
      const r = this.start(rt);
      if (!r.ok) return r;
    }
    if (!this.write(rt, userLine(t))) {
      this.stopProc(rt);
      return { ok: false, message: 'El proceso de Claude no responde; volvé a enviar para reiniciarlo.' };
    }
    addUserMessage(rt.state, t);
    rt.state.status = 'running';
    rt.rec.updatedAt = new Date().toISOString();
    this.save();
    this.push(rt, true);
    return { ok: true, message: 'Enviado' };
  }

  interrupt(id: string): { ok: boolean; message: string } {
    const rt = this.chats.get(id);
    if (!rt?.proc) return { ok: false, message: 'No hay nada en curso' };
    if (!this.write(rt, interruptLine(`int-${++this.seq}`))) return { ok: false, message: 'El proceso ya terminó' };
    return { ok: true, message: 'Deteniendo…' };
  }

  permission(id: string, requestId: string, allow: boolean): { ok: boolean; message: string } {
    const rt = this.chats.get(id);
    const req = rt?.state.pending.find((p) => p.requestId === requestId);
    if (!rt?.proc || !req) return { ok: false, message: 'El pedido ya no está vigente' };
    if (!this.write(rt, permissionLine(requestId, allow, req.input))) return { ok: false, message: 'El proceso ya terminó' };
    rt.state.pending = rt.state.pending.filter((p) => p.requestId !== requestId);
    this.push(rt, true);
    return { ok: true, message: allow ? `Permitido: ${req.toolName}` : `Denegado: ${req.toolName}` };
  }

  /** Cambia el modelo: se aplica reiniciando el proceso con --resume (el contexto se conserva). */
  setModel(id: string, model: string): { ok: boolean; message: string } {
    const rt = this.chats.get(id);
    if (!rt) return { ok: false, message: 'Chat inexistente' };
    if (rt.state.status === 'running') return { ok: false, message: 'Esperá a que termine la respuesta para cambiar de modelo' };
    rt.rec.model = model || undefined;
    rt.state.model = model || undefined;
    this.stopProc(rt);
    this.save();
    this.push(rt, true);
    return { ok: true, message: `Modelo: ${model}. Se aplica en el próximo mensaje (cambiar de modelo invalida la caché).` };
  }

  remove(id: string): void {
    const rt = this.chats.get(id);
    if (!rt) return;
    this.stopProc(rt);
    this.chats.delete(id);
    this.save();
  }

  /** Chat dueño de una sesión de Claude Code (para ejecutar acciones de reglas en ella). */
  bySession(sessionId: string): ChatState | undefined {
    for (const rt of this.chats.values()) if (rt.rec.sessionId === sessionId) return rt.state;
    return undefined;
  }

  /** Estado de un servidor MCP según el último init de algún chat (p. ej. 'connected'). */
  mcpStatus(name: string): string | undefined {
    for (const rt of this.chats.values()) {
      const m = rt.state.mcp.find((x) => x.name === name);
      if (m) return m.status;
    }
    return undefined;
  }

  stopAll(): void {
    for (const rt of this.chats.values()) this.stopProc(rt);
  }

  /** Como stopAll, pero espera a que cada proceso termine (hasta 3 s). */
  async closeAll(): Promise<void> {
    const procs = [...this.chats.values()].map((rt) => rt.proc).filter((p): p is ChildProcess => !!p);
    const exits = procs.map((p) => (p.exitCode !== null ? Promise.resolve() : new Promise<void>((r) => {
      p.once('exit', () => r());
      setTimeout(r, 3000).unref();
    })));
    this.stopAll();
    await Promise.all(exits);
  }

  // ---------- internos ----------

  private start(rt: Runtime): { ok: boolean; message: string } {
    const bin = this.o.claudeBin === undefined ? findClaude(this.o.env) : this.o.claudeBin;
    if (!bin) return { ok: false, message: 'No encontré el CLI de Claude Code (`claude`). Instalalo o abrí VS Code con la extensión de Claude Code.' };
    if (!existsSync(rt.rec.cwd)) return { ok: false, message: `La carpeta de trabajo no existe: ${rt.rec.cwd}` };
    const args = [...(this.o.prefixArgs ?? []), ...cliArgs({ model: rt.rec.model, resume: rt.rec.sessionId })];
    // `.cmd` exige shell en Windows; los argumentos están validados (cliArgs) y el cwd va aparte.
    const shell = /\.(cmd|bat)$/i.test(bin);
    const proc = spawn(shell ? `"${bin}"` : bin, args, { cwd: rt.rec.cwd, env: { ...(this.o.env ?? process.env) }, shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    rt.proc = proc;
    rt.buf = '';
    rt.stderr = '';
    rt.state.status = 'starting';
    // Una escritura después de que el proceso terminó emite 'error' en stdin: no debe tirar la app.
    proc.stdin!.on('error', () => {});
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => this.onData(rt, d));
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => {
      rt.stderr = (rt.stderr + d).slice(-2000);
    });
    proc.on('error', (e) => {
      rt.state.status = 'error';
      rt.state.statusText = `No se pudo lanzar claude: ${e.message}`;
      rt.proc = undefined;
      this.push(rt, true);
    });
    proc.on('exit', (code) => {
      if (rt.proc !== proc) return;
      rt.proc = undefined;
      for (const m of rt.state.messages) m.streaming = false;
      rt.state.pending = [];
      if (rt.state.status === 'running' || rt.state.status === 'starting' || code) {
        rt.state.status = 'error';
        rt.state.statusText = `El proceso terminó (código ${code ?? '?'}). ${rt.stderr.trim().split('\n').slice(-3).join(' ')}`.trim();
      } else rt.state.status = 'exited';
      this.push(rt, true);
    });
    return { ok: true, message: 'Iniciado' };
  }

  /** Escribe una línea al CLI; false si el proceso ya no acepta entrada. */
  private write(rt: Runtime, line: string): boolean {
    const w = rt.proc?.stdin;
    if (!w || w.destroyed || !w.writable) return false;
    try {
      w.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private onData(rt: Runtime, d: string): void {
    rt.buf += d;
    let i: number;
    let resultSeen = false;
    while ((i = rt.buf.indexOf('\n')) >= 0) {
      const line = rt.buf.slice(0, i).trim();
      rt.buf = rt.buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const before = rt.state.sessionId;
      applyCliEvent(rt.state, m);
      if (rt.state.sessionId && rt.state.sessionId !== before) {
        rt.rec.sessionId = rt.state.sessionId;
        this.save();
      }
      if (m.type === 'result' || m.type === 'control_request') resultSeen = true;
    }
    this.push(rt, resultSeen);
  }

  /** Publica el estado (agrupado cada 60 ms mientras llega streaming). */
  private push(rt: Runtime, now = false): void {
    if (now) {
      if (rt.timer) clearTimeout(rt.timer);
      rt.timer = undefined;
      this.o.onUpdate(rt.state);
      this.o.onList(this.list());
      return;
    }
    rt.timer ??= setTimeout(() => {
      rt.timer = undefined;
      this.o.onUpdate(rt.state);
    }, 60);
  }

  private stopProc(rt: Runtime): void {
    const p = rt.proc;
    rt.proc = undefined;
    if (!p) return;
    try {
      p.stdin?.end();
      p.kill();
    } catch {
      // ya terminó
    }
    if (rt.state.status !== 'error') rt.state.status = 'idle';
  }

  private history(rec: ChatRecord): ChatState['messages'] {
    const base = join(this.o.env?.CLAUDE_CONFIG_DIR ?? join(this.o.env?.USERPROFILE ?? homedir(), '.claude'), 'projects');
    for (const cwd of [rec.cwd, rec.cwd.charAt(0).toLowerCase() + rec.cwd.slice(1), rec.cwd.charAt(0).toUpperCase() + rec.cwd.slice(1)]) {
      const f = join(base, encodeProjectDir(cwd), `${rec.sessionId}.jsonl`);
      if (existsSync(f)) {
        try {
          return messagesFromTranscript(readFileSync(f, 'utf8').split('\n'));
        } catch {
          return [];
        }
      }
    }
    return [];
  }

  private readStore(): ChatRecord[] {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(j?.chats) ? j.chats.filter((c: any) => typeof c?.id === 'string' && typeof c?.cwd === 'string') : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ chats: this.list() }, null, 2));
    renameSync(tmp, this.file);
  }
}
