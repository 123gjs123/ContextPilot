import { SseParser } from './sse.js';

// RF-CAP-05 / CP-038: parsers puros del stream SSE de claude.ai y chatgpt.com (la extensión los
// usa sobre la copia `tee` del body). Sin DOM ni red: sólo texto de chunks.
//
// claude.ai (/api/organizations/<org>/chat_conversations/<id>/completion):
//   - Formato actual, tipo Messages API: message_start {message:{id, uuid, model}},
//     content_block_delta {delta:{type:'text_delta', text}} / thinking_delta, message_delta,
//     message_limit, message_stop.
//   - Formato legado: data: {"completion": "...", "stop_reason": null|"stop_sequence", "model": ...}
//     (cada evento trae el fragmento nuevo).
// chatgpt.com (/backend-api/conversation, /backend-api/f/conversation):
//   - Legado acumulativo: data: {"message": {id, author:{role}, content:{content_type, parts:[...]},
//     metadata:{model_slug}, status}, "conversation_id": ...} → cada evento trae el texto completo.
//   - Delta encoding v1 (event: delta): {"p": "", "o": "add", "v": {message...}},
//     {"p": "/message/content/parts/0", "o": "append", "v": "..."}, {"v": "..."} (repite la última
//     ruta/operación), {"o": "patch", "v": [ops...]}. Fin: message_stream_complete y [DONE].

export type WebSite = 'claude.ai' | 'chatgpt.com';

export interface WebStreamResult {
  text: string;
  model?: string;
  done: boolean;
  messageId?: string;
  /** Extensión: id de conversación si el stream lo informa (chatgpt.com). */
  conversationId?: string;
  /** Extensión: texto de razonamiento visible (thinking), consume límite aunque no se muestre como respuesta. */
  reasoningText?: string;
}

export interface WebStreamParser {
  push(chunk: string): void;
  result(): WebStreamResult;
}

export function createWebStreamParser(site: WebSite): WebStreamParser {
  return site === 'claude.ai' ? new ClaudeWebParser() : new ChatGptWebParser();
}

class ClaudeWebParser implements WebStreamParser {
  private sse = new SseParser();
  private text: string[] = [];
  private reasoning: string[] = [];
  private model?: string;
  private messageId?: string;
  private done = false;
  errors = 0;

  push(chunk: string): void {
    for (const ev of this.sse.push(chunk)) this.onEvent(ev.data);
  }

  private onEvent(data: string): void {
    if (!data || data === '[DONE]') {
      if (data === '[DONE]') this.done = true;
      return;
    }
    let d: any;
    try {
      d = JSON.parse(data);
    } catch {
      this.errors++;
      return;
    }
    if (!d || typeof d !== 'object') return;
    // Legado: {completion, stop_reason, model}
    if (typeof d.completion === 'string') {
      this.text.push(d.completion);
      if (d.model) this.model = d.model;
      if (d.log_id && !this.messageId) this.messageId = String(d.log_id);
      if (d.stop_reason) this.done = true;
      return;
    }
    switch (d.type) {
      case 'message_start': {
        const m = d.message ?? {};
        if (m.model) this.model = m.model;
        const id = m.uuid ?? m.id;
        if (id) this.messageId = String(id);
        break;
      }
      case 'content_block_delta': {
        const delta = d.delta ?? {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') this.text.push(delta.text);
        else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') this.reasoning.push(delta.thinking);
        break;
      }
      case 'message_stop':
        this.done = true;
        break;
      case 'error':
        this.done = true;
        break;
    }
  }

  result(): WebStreamResult {
    const r: WebStreamResult = { text: this.text.join(''), done: this.done };
    if (this.model) r.model = this.model;
    if (this.messageId) r.messageId = this.messageId;
    if (this.reasoning.length) r.reasoningText = this.reasoning.join('');
    return r;
  }
}

interface GptMessage {
  id?: string;
  author?: { role?: string };
  content?: { content_type?: string; parts?: unknown[]; text?: string };
  metadata?: { model_slug?: string; default_model_slug?: string };
  status?: string;
  end_turn?: boolean | null;
}

class ChatGptWebParser implements WebStreamParser {
  private sse = new SseParser();
  /** Documento vivo del formato delta (lo que se está parchando). */
  private doc: any = undefined;
  private lastPath = '';
  private lastOp = 'append';
  /** Mensajes vistos, por id (el último estado gana). */
  private messages = new Map<string, GptMessage>();
  private order: string[] = [];
  private conversationId?: string;
  private done = false;
  errors = 0;

  push(chunk: string): void {
    for (const ev of this.sse.push(chunk)) this.onEvent(ev.event, ev.data);
  }

  private onEvent(event: string | undefined, data: string): void {
    if (data === '[DONE]') {
      this.done = true;
      return;
    }
    let d: any;
    try {
      d = JSON.parse(data);
    } catch {
      this.errors++;
      return;
    }
    if (typeof d === 'string') return; // event: delta_encoding / data: "v1"
    if (!d || typeof d !== 'object') return;
    if (d.conversation_id) this.conversationId = String(d.conversation_id);
    if (d.type === 'message_stream_complete') {
      this.done = true;
      return;
    }
    if (d.message && typeof d.message === 'object' && !('o' in d) && !('p' in d)) {
      // Legado acumulativo (o evento completo sin delta).
      this.doc = d;
      this.capture();
      return;
    }
    if ('v' in d || 'o' in d || event === 'delta') {
      this.applyOp(d);
      this.capture();
    }
  }

  private applyOp(op: any): void {
    const path: string = typeof op.p === 'string' ? op.p : this.lastPath;
    const o: string = typeof op.o === 'string' ? op.o : typeof op.p === 'string' ? 'replace' : this.lastOp;
    this.lastPath = path;
    this.lastOp = o;
    if (o === 'patch') {
      for (const sub of Array.isArray(op.v) ? op.v : []) this.applyOp(sub);
      // Tras un patch, un {"v": ...} suelto sigue a la última sub-operación.
      return;
    }
    if (path === '') {
      if (o === 'add' || o === 'replace') {
        this.capture();
        this.doc = op.v;
        if (this.doc?.conversation_id) this.conversationId = String(this.doc.conversation_id);
      }
      return;
    }
    if (!this.doc || typeof this.doc !== 'object') this.doc = {};
    const keys = path
      .split('/')
      .slice(1)
      .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    let parent: any = this.doc;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (parent[k] === undefined || parent[k] === null || typeof parent[k] !== 'object') parent[k] = /^\d+$/.test(keys[i + 1]!) ? [] : {};
      parent = parent[k];
    }
    const last = keys[keys.length - 1]!;
    switch (o) {
      case 'append': {
        const cur = parent[last];
        if (Array.isArray(cur)) cur.push(...(Array.isArray(op.v) ? op.v : [op.v]));
        else if (typeof cur === 'string' || cur === undefined || cur === null) parent[last] = (cur ?? '') + String(op.v ?? '');
        break;
      }
      case 'add':
      case 'replace':
        parent[last] = op.v;
        break;
      case 'remove':
        if (Array.isArray(parent)) parent.splice(Number(last), 1);
        else delete parent[last];
        break;
      case 'truncate':
        if (Array.isArray(parent[last])) parent[last].length = Number(op.v) || 0;
        else if (typeof parent[last] === 'string') parent[last] = parent[last].slice(0, Number(op.v) || 0);
        break;
    }
  }

  /** Guarda una copia del mensaje actual del documento. */
  private capture(): void {
    const m: GptMessage | undefined = this.doc?.message;
    if (!m || typeof m !== 'object') return;
    const id = m.id ?? `anon-${this.order.length}`;
    if (!this.messages.has(id)) this.order.push(id);
    this.messages.set(id, structuredClone(m));
  }

  result(): WebStreamResult {
    let final: GptMessage | undefined;
    const reasoning: string[] = [];
    let model: string | undefined;
    for (const id of this.order) {
      const m = this.messages.get(id)!;
      if (m.author?.role !== 'assistant') continue;
      model = m.metadata?.model_slug ?? model ?? m.metadata?.default_model_slug;
      const ct = m.content?.content_type;
      if (ct === 'thoughts' || ct === 'reasoning_recap') {
        reasoning.push(partsText(m));
        continue;
      }
      if (ct === 'text' || ct === 'multimodal_text' || ct === undefined) final = m;
    }
    const r: WebStreamResult = { text: final ? partsText(final) : '', done: this.done };
    if (final?.metadata?.model_slug) model = final.metadata.model_slug;
    if (model) r.model = model;
    if (final?.id) r.messageId = final.id;
    if (this.conversationId) r.conversationId = this.conversationId;
    const rt = reasoning.filter(Boolean).join('\n');
    if (rt) r.reasoningText = rt;
    return r;
  }
}

function partsText(m: GptMessage): string {
  const c: any = m.content ?? {};
  if (typeof c.text === 'string') return c.text;
  const parts: unknown[] = Array.isArray(c.parts) ? c.parts : [];
  const thoughts: unknown[] = Array.isArray(c.thoughts) ? c.thoughts : [];
  return [
    ...parts.map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')),
    ...thoughts.map((t: any) => (typeof t?.content === 'string' ? t.content : '')),
  ]
    .filter(Boolean)
    .join('');
}
