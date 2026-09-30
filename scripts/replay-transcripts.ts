import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ClaudeCodeParser, RuleEngine, applyEvent, type SessionState } from '../packages/core/src/index.ts';
const root = join(homedir(), '.claude', 'projects');
const files = readdirSync(root).flatMap(d => { try { return readdirSync(join(root,d)).filter(f=>f.endsWith('.jsonl')).map(f=>join(root,d,f)); } catch { return []; } })
  .sort((a,b)=>statSync(b).size-statSync(a).size).slice(0,5);
for (const f of files) {
  const p = new ClaudeCodeParser(); const eng = new RuleEngine(); let st: SessionState|undefined; let n=0, prompts=0; const fired: Record<string,number> = {};
  for (const line of readFileSync(f,'utf8').split('\n')) for (const ev of p.feed(line)) {
    const prev = st; st = applyEvent(prev, ev); ev.phase==='prompt'?prompts++:n++;
    const out = eng.evaluate({ event: ev, prev, state: st, now: Date.parse(ev.ts) });
    for (const s of out.published) { fired[s.ruleId]=(fired[s.ruleId]??0)+1; }
    // simula que el usuario descarta, para que no bloquee la siguiente
    for (const s of out.published) eng.feedback(s.id, 'dismissed', Date.parse(ev.ts));
  }
  console.log(f.split(/[\/]/).slice(-2).join('/').slice(0,60), {responses:n, prompts, ctx: st?.contextSize, win: st?.contextWindow, cache: st?.cacheRatios.at(-1)?.toFixed(2), ttl: st?.cacheTtlMs, errors: p.errors, fired});
}
