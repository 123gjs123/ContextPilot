import * as core from '@contextpilot/core';

// Parser del stream SSE de conversación de claude.ai / Claude Desktop (mismo endpoint).
// TODO(CP-038): cuando `packages/core` exporte `createWebStreamParser('claude.ai')`, se usa ése
// (lo detecta `webStreamParser()` en tiempo de ejecución); este parser local es el respaldo mínimo.

export interface StreamResult {
  model: string;
  outputText: string;
  thinkingText: string;
  stopReason?: string;
}

export interface StreamParser {
  push(chunk: string): void;
  end(): StreamResult;
}

/** Parser local: acumula `content_block_delta` (text/thinking) y el modelo de `message_start`. */
export function createLocalClaudeParser(): StreamParser {
  let buf = '';
  const r: StreamResult = { model: '', outputText: '', thinkingText: '' };
  const handle = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    switch (ev.type) {
      case 'message_start':
        r.model = ev.message?.model ?? r.model;
        break;
      case 'content_block_delta': {
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && typeof d.text === 'string') r.outputText += d.text;
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') r.thinkingText += d.thinking;
        break;
      }
      case 'message_delta':
        r.stopReason = ev.delta?.stop_reason ?? r.stopReason;
        break;
      // Formato viejo de claude.ai: { completion, model, stop_reason }
      case 'completion':
        if (typeof ev.completion === 'string') r.outputText += ev.completion;
        r.model = ev.model ?? r.model;
        break;
    }
  };
  return {
    push(chunk) {
      buf += chunk;
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? '';
      for (const p of parts) handle(p);
    },
    end() {
      if (buf.trim()) handle(buf);
      buf = '';
      return { ...r };
    },
  };
}

/** Usa el parser de core si existe (duck typing sobre push/feed y end/finish); si no, el local. */
export function webStreamParser(): StreamParser {
  const factory = (core as unknown as Record<string, unknown>).createWebStreamParser;
  if (typeof factory === 'function') {
    try {
      const p = (factory as (site: string) => Record<string, any>)('claude.ai');
      const push = (p.push ?? p.feed)?.bind(p);
      const end = (p.end ?? p.finish)?.bind(p);
      if (push && end) {
        return {
          push,
          end() {
            const x = end() ?? {};
            return {
              model: x.model ?? '',
              outputText: x.outputText ?? x.text ?? '',
              thinkingText: x.thinkingText ?? x.thinking ?? '',
              stopReason: x.stopReason,
            };
          },
        };
      }
    } catch {
      /* cae al parser local */
    }
  }
  return createLocalClaudeParser();
}
