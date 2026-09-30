// Utilidades compartidas por los scripts CLI (sin dependencias; Node >= 20).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function cpHome(env = process.env) {
  if (env.CONTEXTPILOT_HOME) return env.CONTEXTPILOT_HOME;
  return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ContextPilot');
}

export function cpPort(env = process.env) {
  const n = Number(env.CONTEXTPILOT_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 47800;
}

export function cpBase(env = process.env) {
  return `http://127.0.0.1:${cpPort(env)}`;
}

export function cpToken(env = process.env) {
  try {
    return readFileSync(join(cpHome(env), 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Lee todo stdin (con tope de tiempo: si nadie escribe, no bloquea). */
export function readStdin(timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    const t = setTimeout(() => done(), timeoutMs);
    const done = () => {
      clearTimeout(t);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
