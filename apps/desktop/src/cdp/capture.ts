import { contextWindowFor, estimateTokens, hash, ulid, type TurnEvent } from '@contextpilot/core';
import { webStreamParser } from './claudeSse.js';

// CP-043: convierte eventos CDP `Network.*` de Claude Desktop en TurnEvent (source 'desktop',
// client 'claude-desktop'). Sólo lectura: usa `Network.getResponseBody`; nunca Runtime/Input/Page.
// Puro respecto de CDP: recibe eventos y una función para leer cuerpos (testeable con CDP simulado).

/** Mismo patrón que usa la propia app (spike): completion, retry_completion, completion2. */
export const COMPLETION_RE = /\/api\/organizations\/[^/]+\/chat_conversations\/([^/?#]+)\/(?:retry_)?completion2?(?:[?#]|$)/;

export interface CdpEventSink {
  onEvent(method: string, params: any): void;
}

export interface CaptureDeps {
  getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }>;
  emit(events: TurnEvent[]): void | Promise<void>;
  now?: () => number;
}

interface Pending {
  conversationId: string;
  promptText: string;
  attachmentsText: string[];
  requestModel?: string;
  regenerated: boolean;
  startedAt: number;
}

interface ConvState {
  turn: number;
  contextSize: number;
  lastTs: number;
  /** Lo que sumó el último turno (para descontarlo si se regenera). */
  lastIncrement: number;
}

function normalizePrompt(t: string): string {
  return t.trim().replace(/\s+/g, ' ');
}

function parseRequestBody(postData: string | undefined): { prompt: string; attachments: string[]; model?: string } {
  if (!postData) return { prompt: '', attachments: [] };
  try {
    const b = JSON.parse(postData) as Record<string, any>;
    const attachments = Array.isArray(b.attachments)
      ? b.attachments.map((a: any) => (typeof a?.extracted_content === 'string' ? a.extracted_content : '')).filter(Boolean)
      : [];
    return { prompt: typeof b.prompt === 'string' ? b.prompt : '', attachments, model: typeof b.model === 'string' ? b.model : undefined };
  } catch {
    return { prompt: '', attachments: [] };
  }
}

export class ClaudeDesktopCapture implements CdpEventSink {
  private pending = new Map<string, Pending>();
  private convs = new Map<string, ConvState>();
  public lastEventAt?: string;
  public errors = 0;

  constructor(private readonly deps: CaptureDeps) {}

  onEvent(method: string, params: any): void {
    if (method === 'Network.requestWillBeSent') {
      const req = params?.request;
      if (!req || req.method !== 'POST' || typeof req.url !== 'string') return;
      const m = COMPLETION_RE.exec(req.url);
      if (!m) return;
      const body = parseRequestBody(req.postData);
      this.pending.set(params.requestId, {
        conversationId: m[1]!,
        promptText: body.prompt,
        attachmentsText: body.attachments,
        requestModel: body.model,
        regenerated: /\/retry_completion/.test(req.url),
        startedAt: this.now(),
      });
    } else if (method === 'Network.loadingFinished') {
      const p = this.pending.get(params?.requestId);
      if (!p) return;
      this.pending.delete(params.requestId);
      void this.finish(params.requestId, p);
    } else if (method === 'Network.loadingFailed') {
      this.pending.delete(params?.requestId);
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async finish(requestId: string, p: Pending): Promise<void> {
    let body: string;
    try {
      const r = await this.deps.getResponseBody(requestId);
      body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
    } catch {
      this.errors++;
      return;
    }
    const ev = this.toEvent(p, body);
    if (ev) {
      this.lastEventAt = ev.ts;
      await this.deps.emit([ev]);
    }
  }

  /** Construye el TurnEvent. Todo es estimado (el SSE de claude.ai no informa `usage`). */
  toEvent(p: Pending, sseBody: string): TurnEvent | null {
    const parser = webStreamParser();
    parser.push(sseBody);
    const res = parser.end();
    if (!res.outputText && !res.thinkingText) return null;
    const model = res.model || p.requestModel || 'claude';
    const sessionId = `claude-desktop:${p.conversationId}`;
    const promptTokens = estimateTokens(p.promptText, 'anthropic');
    const attachTokens = p.attachmentsText.map((t) => estimateTokens(t, 'anthropic'));
    const output = estimateTokens(res.outputText, 'anthropic') + (res.thinkingText ? estimateTokens(res.thinkingText, 'anthropic') : 0);
    const conv = this.convs.get(p.conversationId) ?? { turn: 0, contextSize: 0, lastTs: 0, lastIncrement: 0 };
    const now = this.now();
    // Regeneración: reemplaza la respuesta anterior; no suma turno.
    const turn = p.regenerated ? Math.max(1, conv.turn) : conv.turn + 1;
    const input = promptTokens + attachTokens.reduce((a, b) => a + b, 0);
    // Contexto ≈ acumulado de la conversación observada (si se engancha a mitad, subestima).
    const prior = p.regenerated ? Math.max(0, conv.contextSize - conv.lastIncrement) : conv.contextSize;
    const contextSize = prior + input + output;
    const ev: TurnEvent = {
      id: ulid(now),
      source: 'desktop',
      provider: 'anthropic',
      client: 'claude-desktop',
      sessionId,
      turn,
      ts: new Date(now).toISOString(),
      model,
      tokens: { input: prior + input, output, estimated: true },
      contextSize,
      contextWindow: contextWindowFor(model, 'anthropic'),
      idleSincePrevMs: conv.lastTs ? Math.max(0, p.startedAt - conv.lastTs) : 0,
      promptHash: p.promptText ? hash(normalizePrompt(p.promptText)) : '',
      promptTokens,
      attachments: p.attachmentsText.map((t, i) => ({ hash: hash(t), tokens: attachTokens[i]! })),
      regenerated: p.regenerated || undefined,
    };
    this.convs.set(p.conversationId, { turn, contextSize, lastTs: now, lastIncrement: input + output });
    return ev;
  }
}
