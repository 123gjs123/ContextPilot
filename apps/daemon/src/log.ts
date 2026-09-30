import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// Log mínimo a archivo. Nunca se loguean headers, cuerpos ni contenido de conversaciones (RNF-01, RNF-04).

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(dir: string | null, echo = false): Logger {
  const file = dir ? join(dir, 'daemon.log') : null;
  const write = (level: string, msg: string) => {
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    if (echo) process.stderr.write(line);
    if (!file) return;
    try {
      appendFileSync(file, line);
    } catch {
      // el log nunca rompe el daemon
    }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };
