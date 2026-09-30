// Construcción de TurnEvent para la web (CP-038.2). Todo estimado (estimated: true).
// input  = estimación de toda la conversación visible antes de la respuesta nueva (incluye el prompt
//          si ya está renderizado; si no, se suma aparte) + adjuntos.
// output = estimación del texto de la respuesta.
// contextSize = input + output (D «fórmula de ocupación»: lo que viaja en el próximo turno).
import {
  cleanTitle,
  contentWordCount,
  contextWindowFor,
  embed,
  estimateTokens,
  hash,
  redact,
  splitBlocks,
  ulid,
  type TurnEvent,
} from '@contextpilot/core';
import { SITES, type SiteId } from './sites.js';

export interface TurnCapture {
  site: SiteId;
  conversationId: string;
  /** Índice del prompt del usuario (cantidad de mensajes de usuario visibles). */
  turn: number;
  answerText: string;
  /** Razonamiento visible (thinking): consume salida pero no queda en el contexto. */
  reasoningText?: string;
  promptText?: string;
  /** Texto visible de la conversación antes de la respuesta nueva. */
  priorText: string;
  model?: string;
  regenerated?: boolean;
  attachments?: { hash: string; tokens: number }[];
  expensiveMode?: string;
  now: number;
  /** Momento del turno anterior de la misma sesión (para idleSincePrevMs). */
  prevTs?: number;
  /** CP-061: título de la conversación (título de la pestaña sin el nombre del sitio). */
  title?: string;
  via: 'net' | 'dom';
}

export function normalizeText(t: string): string {
  return t.replace(/\s+/g, ' ').trim();
}

/** Mismo criterio que core (hash de texto normalizado). */
export function promptHashOf(prompt: string): string {
  return prompt ? hash(normalizeText(prompt)) : '';
}

export function sessionIdFor(site: SiteId, conversationId: string): string {
  return `${site}:${conversationId}`;
}

export function buildTurnEvent(c: TurnCapture): TurnEvent {
  const site = SITES[c.site];
  const provider = site.provider;
  const model = c.model?.trim() || site.defaultModel;
  const prompt = c.promptText ?? '';
  const promptTokens = prompt ? estimateTokens(prompt, provider) : 0;

  let input = estimateTokens(c.priorText, provider);
  if (prompt) {
    // Si el prompt todavía no estaba en el DOM, se suma aparte.
    const probe = normalizeText(prompt).slice(0, 200);
    if (probe && !normalizeText(c.priorText).includes(probe)) input += promptTokens;
  }
  const attachTokens = (c.attachments ?? []).reduce((s, a) => s + a.tokens, 0);
  input += attachTokens;
  const output = estimateTokens(c.answerText, provider);

  const safePrompt = redact(prompt);
  const ev: TurnEvent = {
    id: ulid(c.now),
    source: 'web',
    provider,
    client: site.id,
    sessionId: sessionIdFor(site.id, c.conversationId),
    turn: Math.max(1, c.turn),
    ts: new Date(c.now).toISOString(),
    model,
    tokens: { input, output, estimated: true },
    contextSize: input + output,
    contextWindow: contextWindowFor(model, provider),
    idleSincePrevMs: c.prevTs !== undefined ? Math.max(0, c.now - c.prevTs) : 0,
    promptHash: promptHashOf(prompt),
    promptTokens,
    phase: 'response',
  };
  if (safePrompt) {
    ev.promptEmbedding = embed(safePrompt);
    ev.promptContentWords = contentWordCount(safePrompt);
  }
  const title = cleanTitle(c.title);
  if (title) ev.title = title;
  const blocks = safePrompt ? splitBlocks(safePrompt) : [];
  if (blocks.length) ev.blocks = blocks;
  if (c.attachments?.length) ev.attachments = c.attachments;
  if (c.reasoningText) ev.tokens.reasoning = estimateTokens(c.reasoningText, provider);
  if (c.regenerated) ev.regenerated = true;
  if (c.expensiveMode) ev.expensiveMode = c.expensiveMode;
  return ev;
}

/** Títulos genéricos de los sitios (no identifican la conversación). */
const GENERIC_TITLES = /^(claude|chatgpt|gemini|google gemini|new chat|nuevo chat|nueva conversación)$/i;

/**
 * CP-061: título de la conversación desde `document.title` («Plan de pruebas - Claude» →
 * «Plan de pruebas»). undefined si es el título genérico del sitio.
 */
export function titleFromDocument(docTitle: string | undefined): string | undefined {
  if (!docTitle) return undefined;
  const t = docTitle.replace(/\s+[-–—|]\s+(Claude|ChatGPT|Gemini|Google Gemini)\s*$/i, '').trim();
  if (!t || GENERIC_TITLES.test(t)) return undefined;
  return cleanTitle(t);
}
