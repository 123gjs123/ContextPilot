import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { clearCommand, isCli, redact, textOf, type Source } from '@contextpilot/core';

// CP-052: traspaso. El contenido se lee en el momento del pedido (transcript en disco o texto que
// manda la extensión), se redacta y se procesa en memoria; nunca se persiste (DECISIONS).
// Resumen con la CLI de Claude Code en modo headless (suscripción del usuario); fallback extractivo.

export interface ConvTurn {
  role: 'user' | 'assistant';
  text: string;
  tools?: { name: string; input: Record<string, unknown> }[];
}

export interface HandoffResult {
  summary: string;
  command?: string;
  method: 'claude-cli' | 'extractive';
}

export interface ClaudeRun {
  text: string;
  input: number;
  output: number;
  costUsd: number;
}

const MAX_CONV_CHARS = 60_000;
const MAX_SUMMARY_CHARS = 6000;

// ---------- lectura de transcripts ----------

/** Transcript JSONL (Claude Code o Codex) → turnos de conversación redactados. */
export function readTranscript(text: string): ConvTurn[] {
  const out: ConvTurn[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec: any;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    const turn = claudeRecord(rec) ?? codexRecord(rec);
    if (!turn) continue;
    const last = out.at(-1);
    // Claude Code parte un mensaje en varias líneas (un bloque por línea): se fusionan.
    if (last && last.role === turn.role && turn.role === 'assistant') {
      if (turn.text) last.text = last.text ? `${last.text}\n${turn.text}` : turn.text;
      if (turn.tools?.length) last.tools = [...(last.tools ?? []), ...turn.tools];
    } else out.push(turn);
  }
  return out;
}

function claudeRecord(rec: any): ConvTurn | null {
  if (rec?.isSidechain || rec?.isMeta || rec?.isCompactSummary) return null;
  if (rec?.type === 'user' && rec.message) {
    const c = rec.message.content;
    if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) return null;
    const text = textOf(c).trim();
    if (!text || text.startsWith('<command-') || text.startsWith('<local-command')) return null;
    return { role: 'user', text: redact(text) };
  }
  if (rec?.type === 'assistant' && rec.message) {
    const blocks = Array.isArray(rec.message.content) ? rec.message.content : [];
    const text = blocks
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    const tools = blocks
      .filter((b: any) => b?.type === 'tool_use')
      .map((b: any) => ({ name: String(b.name), input: pickToolInput(b.input) }));
    if (!text && !tools.length) return null;
    return { role: 'assistant', text: redact(text), tools };
  }
  return null;
}

function codexRecord(rec: any): ConvTurn | null {
  const p = rec?.payload ?? rec;
  if (p?.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const text = (Array.isArray(p.content) ? p.content : [])
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
      .join('\n')
      .trim();
    if (!text || text.startsWith('<environment_context>') || text.startsWith('<user_instructions>')) return null;
    return { role: p.role, text: redact(text) };
  }
  if (p?.type === 'function_call' && typeof p.name === 'string') {
    let input: Record<string, unknown> = {};
    try {
      input = pickToolInput(JSON.parse(p.arguments ?? '{}'));
    } catch {
      input = {};
    }
    return { role: 'assistant', text: '', tools: [{ name: p.name, input }] };
  }
  return null;
}

/** De los argumentos de herramientas sólo interesan rutas y comandos (redactados). */
function pickToolInput(input: any): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') return o;
  for (const k of ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'description']) {
    if (typeof input[k] === 'string') o[k] = redact(String(input[k])).slice(0, 300);
    else if (Array.isArray(input[k])) o[k] = redact(input[k].join(' ')).slice(0, 300);
  }
  if (Array.isArray(input.todos)) {
    o.todos = input.todos.map((t: any) => ({ content: redact(String(t?.content ?? '')).slice(0, 200), status: t?.status }));
  }
  return o;
}

/** Texto plano de la extensión → turnos (líneas «Usuario:/Asistente:» si existen; si no, un bloque). */
export function readPlainContent(text: string): ConvTurn[] {
  const clean = redact(text);
  const re = /^(user|usuario|human|you|tú|vos|assistant|asistente|claude|chatgpt|gemini|model)\s*:\s*/i;
  const out: ConvTurn[] = [];
  for (const line of clean.split('\n')) {
    const m = re.exec(line);
    if (m) {
      const role = /user|usuario|human|you|tú|vos/i.test(m[1]!) ? 'user' : 'assistant';
      out.push({ role, text: line.slice(m[0].length) });
    } else if (out.length) out.at(-1)!.text += `\n${line}`;
    else out.push({ role: 'user', text: line });
  }
  return out.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text);
}

/** Conversación compacta para el modelo: últimos MAX_CONV_CHARS caracteres. */
export function renderConversation(conv: ConvTurn[]): string {
  const parts = conv.map((t) => {
    const tools = (t.tools ?? [])
      .map((x) => `  [${x.name}] ${Object.entries(x.input).filter(([k]) => k !== 'todos').map(([k, v]) => `${k}=${String(v)}`).join(' ')}`)
      .join('\n');
    const head = t.role === 'user' ? 'USUARIO' : 'ASISTENTE';
    return `${head}: ${t.text.slice(0, 4000)}${tools ? `\n${tools}` : ''}`;
  });
  let text = parts.join('\n\n');
  if (text.length > MAX_CONV_CHARS) text = '…\n' + text.slice(text.length - MAX_CONV_CHARS);
  return text;
}

// ---------- resumen extractivo (determinista) ----------

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function extractiveSummary(conv: ConvTurn[]): string {
  const users = conv.filter((t) => t.role === 'user' && t.text.length >= 3);
  const assistants = conv.filter((t) => t.role === 'assistant' && t.text);
  const tools = conv.flatMap((t) => t.tools ?? []);

  const goals: string[] = [];
  if (users[0]) goals.push(`Inicio: ${clip(users[0].text, 400)}`);
  for (const u of users.slice(-3)) if (u !== users[0]) goals.push(clip(u.text, 400));

  const lastAssistant = assistants.at(-1);
  const state = lastAssistant ? clip(lastAssistant.text, 600) : 'Sin respuesta del asistente todavía.';

  const decisionRe = /\b(decid|decisi[oó]n|vamos a|usaremos|usamos|opt[eé]|elegimos|conviene|we (?:will|decided)|decided|going with)\b/i;
  const decisions: string[] = [];
  for (const a of assistants) {
    for (const line of a.text.split(/\n|(?<=\.)\s/)) {
      if (decisionRe.test(line) && line.trim().length > 15) decisions.push(clip(line, 200));
    }
  }

  const files = new Map<string, string>();
  for (const t of tools) {
    const p = (t.input.file_path ?? t.input.notebook_path ?? t.input.path) as string | undefined;
    if (!p) continue;
    const edited = /edit|write|apply_patch|notebook/i.test(t.name);
    const prev = files.get(p);
    files.delete(p);
    files.set(p, edited || prev === 'editado' ? 'editado' : 'leído');
  }
  const commands = tools
    .filter((t) => typeof t.input.command === 'string')
    .map((t) => clip(String(t.input.command), 120))
    .slice(-5);

  const todoTool = [...tools].reverse().find((t) => Array.isArray(t.input.todos));
  const todos = ((todoTool?.input.todos as { content: string; status?: string }[] | undefined) ?? [])
    .filter((t) => t.status !== 'completed')
    .map((t) => `${t.content}${t.status === 'in_progress' ? ' (en curso)' : ''}`);
  const nextRe = /\b(TODO|pendiente|falta|próximo paso|siguiente paso|next step|remaining)\b/i;
  for (const a of assistants.slice(-3)) {
    for (const line of a.text.split('\n')) if (nextRe.test(line) && line.trim().length > 8) todos.push(clip(line, 200));
  }

  const list = (xs: string[], empty: string) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : `- ${empty}`);
  const fileLines = [...files.entries()].slice(-15).map(([p, k]) => `${p} (${k})`);
  const out = [
    '## Objetivo',
    list(goals, 'Sin prompts del usuario.'),
    '',
    '## Estado',
    state,
    '',
    '## Decisiones',
    list([...new Set(decisions)].slice(-6), 'Sin decisiones explícitas detectadas.'),
    '',
    '## Archivos',
    list(fileLines, 'Sin archivos tocados.'),
    ...(commands.length ? ['', 'Comandos recientes:', list(commands, '')] : []),
    '',
    '## Próximos pasos',
    list([...new Set(todos)].slice(0, 10), 'Retomar desde el último pedido del usuario.'),
  ].join('\n');
  return out.length > MAX_SUMMARY_CHARS ? out.slice(0, MAX_SUMMARY_CHARS - 1) + '…' : out;
}

// ---------- CLI de Claude Code ----------

/** Busca `claude` en PATH o el binario nativo de la extensión de VS Code. `CONTEXTPILOT_CLAUDE_BIN=none` lo desactiva. */
export function findClaudeBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const forced = env.CONTEXTPILOT_CLAUDE_BIN;
  if (forced === 'none') return null;
  if (forced) return existsSync(forced) ? forced : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = join(dir, `claude${ext}`);
      try {
        if (existsSync(f) && statSync(f).isFile()) return f;
      } catch {
        // seguir buscando
      }
    }
  }
  const extDir = join(env.USERPROFILE ?? homedir(), '.vscode', 'extensions');
  try {
    const candidates = readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort(compareVersionsDesc)
      .map((d) => join(extDir, d, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude'));
    return candidates.find((f) => existsSync(f)) ?? null;
  } catch {
    return null;
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const v = (s: string) => (s.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? ['0', '0', '0']).map(Number);
  const [x, y] = [v(a), v(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
  return 0;
}

export function buildPrompt(conversation: string): string {
  return [
    'Generá un resumen de traspaso para continuar esta tarea en una sesión nueva, sin la conversación original.',
    'Usá exactamente estas secciones en markdown: "## Objetivo", "## Estado", "## Decisiones", "## Archivos", "## Próximos pasos".',
    'Máximo 1500 tokens. Concreto: rutas de archivos, comandos, decisiones tomadas y lo que falta. Sin saludos ni preámbulo.',
    'Respondé sólo con el resumen.',
    '',
    '<conversacion>',
    conversation,
    '</conversacion>',
  ].join('\n');
}

export function runClaude(bin: string, prompt: string, opts: { model: string; cwd: string; timeoutMs: number }): Promise<ClaudeRun> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', opts.model, '--output-format', 'json'];
    const isCmd = /\.(cmd|bat)$/i.test(bin);
    mkdirSync(opts.cwd, { recursive: true });
    const env = { ...process.env, CONTEXTPILOT_HANDOFF: '1' };
    const child = isCmd
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${bin}" ${args.join(' ')}`], { cwd: opts.cwd, env, windowsVerbatimArguments: true, windowsHide: true })
      : spawn(bin, args, { cwd: opts.cwd, env, windowsHide: true });
    const out: Buffer[] = [];
    let settled = false;
    const done = (err: Error | null, v?: ClaudeRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(v!);
    };
    const timer = setTimeout(() => {
      child.kill();
      done(new Error('timeout'));
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', () => {});
    child.on('error', (e) => done(e));
    child.on('close', (code) => {
      if (code !== 0) return done(new Error(`claude salió con ${code}`));
      try {
        const j = JSON.parse(Buffer.concat(out).toString('utf8'));
        if (j.is_error || typeof j.result !== 'string' || !j.result.trim()) return done(new Error('respuesta sin resultado'));
        const u = j.usage ?? {};
        done(null, {
          text: j.result.trim(),
          input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          output: u.output_tokens ?? 0,
          costUsd: Number(j.total_cost_usd ?? 0),
        });
      } catch (e) {
        done(e as Error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
  });
}

// ---------- servicio ----------

export class HandoffError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export interface HandoffDeps {
  transcriptFor(sessionId: string): { path: string; source: string } | undefined;
  sourceFor(sessionId: string): Source | undefined;
  claudeBin(): string | null;
  model: () => string;
  cwd: string;
  timeoutMs?: number;
  recordUsage(method: string, input: number, output: number, costUsd: number): void;
  log: { warn(m: string): void };
}

export async function handoff(deps: HandoffDeps, req: { sessionId: string; content?: string }): Promise<HandoffResult> {
  let conv: ConvTurn[];
  let source: Source | undefined = deps.sourceFor(req.sessionId);
  if (typeof req.content === 'string' && req.content.trim()) {
    conv = readPlainContent(req.content);
    source ??= 'web';
  } else {
    const t = deps.transcriptFor(req.sessionId);
    if (!t || !existsSync(t.path)) throw new HandoffError(404, 'sin transcript para la sesión');
    conv = readTranscript(readFileSync(t.path, 'utf8'));
    source ??= t.source as Source;
  }
  const command = source && isCli(source) ? (clearCommand(source) ?? undefined) : undefined;
  if (!conv.length) return { summary: extractiveSummary(conv), command, method: 'extractive' };

  const bin = deps.claudeBin();
  if (bin) {
    try {
      const r = await runClaude(bin, buildPrompt(renderConversation(conv)), {
        model: deps.model(),
        cwd: deps.cwd,
        timeoutMs: deps.timeoutMs ?? 60_000,
      });
      deps.recordUsage('claude-cli', r.input, r.output, r.costUsd);
      return { summary: redact(r.text), command, method: 'claude-cli' };
    } catch (e) {
      deps.log.warn(`handoff: claude -p falló (${(e as Error).message}); uso resumen extractivo`);
    }
  }
  return { summary: extractiveSummary(conv), command, method: 'extractive' };
}
