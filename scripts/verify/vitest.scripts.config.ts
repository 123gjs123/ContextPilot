// Verificación (aceptación ronda 2): corre scripts/test/**, que el vitest.config.ts raíz no incluye (D-19).
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { root: new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), include: ['scripts/test/**/*.test.ts'], environment: 'node', pool: 'forks' },
});
