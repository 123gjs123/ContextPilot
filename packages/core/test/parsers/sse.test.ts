import { describe, expect, it } from 'vitest';
import {
  SseParser,
  createUsageExtractor,
  estimateTokens,
  extractUsageFromJson,
  geminiModelFromUrl,
  proxySessionId,
  requestInfo,
  type Provider,
} from '../../src/index.js';
import { fixture } from '../helpers.js';

/** Alimenta el extractor en chunks de tamaño fijo (partiendo líneas y eventos). */
function extract(provider: Provider, text: string, chunk = 7) {
  const x = createUsageExtractor(provider);
  for (let i = 0; i < text.length; i += chunk) x.push(text.slice(i, i + chunk));
  return x.end();
}

describe('SseParser', () => {
  it('eventos con \\r\\n, comentarios y data multilínea', () => {
    const p = new SseParser();
    const evs = [...p.push(': ping\r\nevent: a\r\ndata: 1\r'), ...p.push('\ndata: 2\r\n\r\n'), ...p.push('data: x'), ...p.end()];
    expect(evs).toEqual([
      { event: 'a', data: '1\n2' },
      { event: undefined, data: 'x' },
    ]);
  });
});

describe('createUsageExtractor', () => {
  it('Anthropic Messages SSE: message_start + message_delta', () => {
    const r = extract('anthropic', fixture('proxy/anthropic-messages.sse'));
    expect(r.model).toBe('claude-sonnet-4-5-20250929');
    expect(r.usage).toEqual({ input: 12, output: 57, cacheRead: 30500, cacheWrite: 2048, estimated: false });
    expect(r.text).toBe('Hola, ¿en qué te ayudo?');
  });

  it('OpenAI Chat Completions SSE con include_usage', () => {
    const r = extract('openai', fixture('proxy/openai-chat.sse'), 13);
    expect(r.model).toBe('gpt-4.1-2025-04-14');
    expect(r.usage).toEqual({ input: 2150 - 1920, output: 3, cacheRead: 1920, estimated: false });
    expect(r.text).toBe('Hola mundo');
  });

  it('OpenAI Responses SSE: response.completed con cached/reasoning', () => {
    const r = extract('openai', fixture('proxy/openai-responses.sse'), 5);
    expect(r.model).toBe('gpt-5-2025-08-07');
    expect(r.usage).toEqual({ input: 5400 - 4096, output: 350, cacheRead: 4096, reasoning: 320, estimated: false });
    expect(r.text).toBe('Listo: 42.');
  });

  it('Gemini streamGenerateContent alt=sse: gana el último usageMetadata; thoughts excluidos del texto', () => {
    const r = extract('google', fixture('proxy/gemini-stream.sse'), 11);
    expect(r.model).toBe('gemini-2.5-flash');
    expect(r.usage).toEqual({ input: 9800 - 8192, output: 7, cacheRead: 8192, reasoning: 150, estimated: false });
    expect(r.text).toBe('El resultado es 42.');
  });

  it('sin usage (stream cortado) → usage undefined, sin lanzar', () => {
    const r = extract('openai', 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {roto\n\n');
    expect(r.usage).toBeUndefined();
    expect(r.text).toBe('a');
  });

  it('cuerpo JSON no-stream pasado por el extractor', () => {
    const body = JSON.stringify({ id: 'msg', type: 'message', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 2 } });
    const r = extract('anthropic', body);
    expect(r.usage).toMatchObject({ input: 5, output: 2 });
    expect(r.text).toBe('ok');
  });
});

describe('extractUsageFromJson', () => {
  it('Anthropic sin campo type', () => {
    expect(extractUsageFromJson('anthropic', { model: 'm', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 } }).usage).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      estimated: false,
    });
  });
  it('OpenAI chat completo', () => {
    const r = extractUsageFromJson('openai', {
      object: 'chat.completion',
      model: 'gpt-4o',
      choices: [{ message: { content: 'hola' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } },
    });
    expect(r).toEqual({ model: 'gpt-4o', text: 'hola', usage: { input: 4, output: 4, cacheRead: 6, estimated: false } });
  });
  it('OpenAI Responses completo', () => {
    const r = extractUsageFromJson('openai', {
      object: 'response',
      model: 'gpt-5',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } },
    });
    expect(r.usage).toEqual({ input: 10, output: 5, cacheRead: 0, reasoning: 2, estimated: false });
    expect(r.text).toBe('hi');
  });
  it('Gemini generateContent y array de streamGenerateContent sin alt=sse', () => {
    const chunk = (t: string, out: number) => ({ candidates: [{ content: { parts: [{ text: t }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: out }, modelVersion: 'gemini-2.5-pro' });
    expect(extractUsageFromJson('google', chunk('a', 1)).usage).toMatchObject({ input: 100, output: 1 });
    const r = extractUsageFromJson('google', [chunk('a', 1), chunk('b', 2)]);
    expect(r.text).toBe('ab');
    expect(r.usage).toMatchObject({ output: 2 });
  });
});

describe('requestInfo', () => {
  it('Anthropic: modelo, herramientas con costo de definición, hashes de system y primer user', () => {
    const tool = { name: 'get_weather', description: 'Clima actual', input_schema: { type: 'object', properties: { city: { type: 'string' } } } };
    const body = { model: 'claude-sonnet-4-5', system: [{ type: 'text', text: 'Sos útil.' }], messages: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'hey' }], tools: [tool] };
    const r = requestInfo('anthropic', body);
    expect(r.model).toBe('claude-sonnet-4-5');
    expect(r.toolsDeclared).toEqual([{ name: 'get_weather', definitionTokens: estimateTokens(JSON.stringify(tool), 'anthropic') }]);
    expect(r.systemHash).toBeTruthy();
    expect(r.firstUserHash).toBeTruthy();
    expect(r.promptTokensEstimate).toBeGreaterThan(r.toolsDeclared[0]!.definitionTokens);
    // Mismo system y primer mensaje → mismo sessionId aunque la conversación crezca.
    const r2 = requestInfo('anthropic', { ...body, messages: [...body.messages, { role: 'user', content: 'otra cosa' }] });
    expect(proxySessionId('anthropic', r2)).toBe(proxySessionId('anthropic', r));
    expect(proxySessionId('anthropic', r, 'mi-sesion')).toBe('mi-sesion');
  });

  it('OpenAI chat y responses; herramientas function y built-in', () => {
    const chat = requestInfo('openai', {
      model: 'gpt-4.1',
      messages: [{ role: 'developer', content: 'reglas' }, { role: 'user', content: [{ type: 'text', text: 'hola' }] }],
      tools: [{ type: 'function', function: { name: 'buscar', parameters: {} } }],
    });
    expect(chat.toolsDeclared.map((t) => t.name)).toEqual(['buscar']);
    expect(chat.systemHash).toBeTruthy();
    const resp = requestInfo('openai', { model: 'gpt-5', instructions: 'reglas', input: 'hola', tools: [{ type: 'web_search' }, { type: 'function', name: 'f' }] });
    expect(resp.toolsDeclared.map((t) => t.name)).toEqual(['web_search', 'f']);
    expect(resp.firstUserHash).toBe(chat.firstUserHash);
  });

  it('Gemini: modelo desde URL, functionDeclarations individuales', () => {
    const r = requestInfo(
      'google',
      {
        systemInstruction: { parts: [{ text: 'sé breve' }] },
        contents: [{ role: 'user', parts: [{ text: 'hola' }] }],
        tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }] }, { googleSearch: {} }],
      },
      { url: '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse' },
    );
    expect(r.model).toBe('gemini-2.5-pro');
    expect(r.toolsDeclared.map((t) => t.name)).toEqual(['a', 'b', 'googleSearch']);
    expect(geminiModelFromUrl('/v1/models/gemini-2.5-flash:generateContent')).toBe('gemini-2.5-flash');
  });

  it('body no objeto no lanza', () => {
    expect(requestInfo('anthropic', null)).toEqual({ promptTokensEstimate: 0, toolsDeclared: [] });
  });
});
