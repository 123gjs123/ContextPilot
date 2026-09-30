import { startDaemon } from './daemon.js';
import { resolveHome, resolvePort } from './paths.js';

// Entrada del daemon: `tsx apps/daemon/src/main.ts` (o `node scripts/with-ca.mjs -- npm start -w @contextpilot/daemon`).
// Datos en %LOCALAPPDATA%\ContextPilot (CONTEXTPILOT_HOME), puerto 47800 (CONTEXTPILOT_PORT).

async function main(): Promise<void> {
  const home = resolveHome();
  const port = resolvePort();
  let d;
  try {
    d = await startDaemon({ home, port, echoLog: process.env.CONTEXTPILOT_LOG_STDERR === '1' });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    process.stderr.write(
      code === 'EADDRINUSE'
        ? `ContextPilot: el puerto ${port} está en uso (¿otro daemon corriendo?)\n`
        : `ContextPilot: no pudo arrancar: ${(e as Error).message}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`ContextPilot daemon ${d.version} en http://127.0.0.1:${d.port} (datos: ${home})\n`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await d.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGBREAK', shutdown);
  process.on('uncaughtException', (e) => d.log.error(`excepción no capturada: ${e.message}`));
  process.on('unhandledRejection', (e) => d.log.error(`promesa rechazada: ${(e as Error)?.message ?? String(e)}`));
}

void main();
