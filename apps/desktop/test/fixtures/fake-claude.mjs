// CLI falso de Claude Code para tests del chat: habla stream-json como `claude -p`.
// Mensaje común: texto en streaming. Mensaje con «bash»: pide permiso y respeta la respuesta.
import { createInterface } from 'node:readline';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const sid = arg('--resume', '11111111-2222-3333-4444-555555555555');
const model = arg('--model', 'claude-sonnet-x');
out({
  type: 'system',
  subtype: 'init',
  session_id: sid,
  model,
  cwd: process.cwd(),
  skills: ['qatc-sbf-migration', 'review'],
  slash_commands: ['compact', 'clear', 'review'],
  mcp_servers: [{ name: 'claude.ai Atlassian', status: 'connected' }],
});
let n = 0;
let waiting = null;
const ev = (event) => out({ type: 'stream_event', event });
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_response' && waiting) {
    const allow = m.response.response.behavior === 'allow';
    const id = waiting;
    waiting = null;
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: allow ? 'hola' : 'denegado', is_error: !allow }] } });
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 50, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, session_id: sid });
    return;
  }
  if (m.type === 'control_request' && m.request && m.request.subtype === 'interrupt') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrumpido', usage: {}, session_id: sid });
    return;
  }
  if (m.type !== 'user') return;
  n++;
  const text = m.message.content;
  const msgId = `msg_${process.pid}_${n}`;
  ev({ type: 'message_start', message: { id: msgId } });
  if (/bash/i.test(text)) {
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"echo hola"}' } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_stop' });
    out({ type: 'assistant', message: { id: msgId, model, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hola' } }] } });
    waiting = 'tu1';
    out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hola' } } });
    return;
  }
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const part of ['Hola, ', 'soy ', '**Claude**.']) ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } });
  ev({ type: 'content_block_stop', index: 0 });
  ev({ type: 'message_stop' });
  out({ type: 'assistant', message: { id: msgId, model, content: [{ type: 'text', text: 'Hola, soy **Claude**.' }] } });
  out({ type: 'rate_limit_event', rate_limit_info: { resetsAt: 1, unifiedWindows: { five_hour: { utilization: 0.3 }, seven_day: { utilization: 0.05 } } } });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 26302, cache_creation_input_tokens: 8584 }, session_id: sid });
});
