import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // D-17: pool explícito (forks: aislamiento por proceso, necesario para sql.js/child_process) y
    // tiempo de teardown holgado para que los hijos que lanzan los tests (daemon aparte, scripts)
    // terminen antes de cerrar el canal IPC del worker.
    pool: 'forks',
    teardownTimeout: 15_000,
  },
});
