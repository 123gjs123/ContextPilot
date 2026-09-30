# Informe scripts-1 — D-7 (CP-003) y D-12 (CP-034.3, CP-057.1)

Alcance: `scripts/` (sin tocar `statusline.mjs`), `docs/INSTALL.md` §7/§10/§11, una línea de `vitest.config.ts`
(glob `scripts/test/**/*.test.ts`). Core y apps sólo se importan (lectura). Sin commit.

## Entregado

| Criterio | Archivo | Estado |
| --- | --- | --- |
| CP-003.1 | `scripts/snapshot-fixtures.mjs` (+ alias `scripts/verify/snapshot-fixtures.mjs`), lógica en `scripts/lib/snapshot.ts`, descubrimiento en `scripts/lib/transcripts.ts` | Implementado; dry-run real OK; **no se escribieron fixtures** |
| CP-003.2 | `scripts/lib/replay.ts`: `replay(files, { sourceParser, config, rules, feedback })` → `{ events, sessions, suggestions, suggestionsByRule, suppressedByRule, perActiveHour, errors }` y `streamReplay(src, dest, { speed })` (appends con una línea partida) | Implementado + tests |
| — | `scripts/replay-transcripts.ts` refactorizado sobre `replay()`: `--top N`, `--recent N`, `--rules`, `--source`, `--no-subagents`, `--json`, archivos explícitos | Implementado |
| CP-034.3 | `scripts/install-gemini-telemetry.mjs` (`--dry-run` diff, `--uninstall`, `--otlp`, `--outfile`, `--settings`, `--home`) | Implementado + tests (HOME temporal) |
| CP-057.1 | `scripts/team-export.mjs --week [YYYY-Www] --out f.json [--offline] [--db]`, lógica en `scripts/lib/team-export.ts` | Implementado + tests |

## Decisiones / hallazgos

1. **El sanitizador del core deja pasar identidad** (verificado con transcripts reales): claves de objetos
   libres (`snapshot.trackedFileBackups` indexado por ruta `C:\Users\<usuario>\…`, `answers` de
   AskUserQuestion indexado por el texto de la pregunta, `featureFlags`), nombres de etiquetas `<…>`
   escritas por el usuario (`<usuario>`, `<nombre-de-proyecto>`) y valores de claves "de metadato" (`type`,
   `id`, …) dentro de inputs de herramientas. Como `packages/core` no es mi alcance, `snapshot-fixtures`
   agrega una **capa 2** que reemplaza esos casos por placeholders de igual longitud. El test
   `snapshot-fixtures.test.ts` documenta que sólo con el core la verificación falla.
   **Recomendación para el dueño de core:** llevar esa lógica a `sanitizeTranscriptLine` (claves no
   identificador → placeholder; etiquetas fuera de una lista blanca → placeholder; KEEP_KEYS sólo con
   forma de id/enum).
2. Verificación de fuga del snapshot: (a) términos de identidad (usuario/host del sistema, segmentos de
   `cwd`, `gitBranch`, emails vistos; se excluye el vocabulario del esquema para no romper `type:"assistant"`
   cuando un proyecto se llama `qa-lead-assistant`), (b) patrones de ruta/email, (c) intersección de tokens
   contenido-original ∩ resultado (sólo quedan claves/ids/tipos; se imprime muestra para revisión), (d)
   **equivalencia de uso**: parsear original y sanitizado debe dar las mismas llamadas, tokens, tools y fallos.
   (d) atrapó un bug propio en desarrollo (renombrar `type:"assistant"` borraba todos los eventos).
3. La regex de email sobre líneas con corridas largas de `xxxx` era cuadrática (88 s de CPU); se busca sólo
   en ventanas alrededor de cada `@` (dry-run completo: ~1 s).
4. Fixtures de subagentes se escriben en `real-<n>/subagents/agent-<k>.jsonl`; `replay()` detecta sidechain
   por la ruta y atribuye por el `sessionId` del registro (los subagentes ya traen el del padre).
5. Gemini CLI: bloque pedido `{ enabled, target:'local', otlpEndpoint:'', outfile, logPrompts:false }`
   (esquema `telemetry` de Gemini CLI: enabled/target/otlpEndpoint/otlpProtocol/outfile/logPrompts/
   useCollector; se conservan claves ajenas). Default = escribir; `--dry-run` sólo diff (CP-034.3 dice que
   el comando escribe). `--uninstall` sólo toca un bloque reconocido como propio y restaura el del backup.
   Acepta JSON con comentarios (se avisa que se pierden). Sin Gemini CLI instalado: esquema sin verificar
   contra una versión real (H-6).
6. `team-export`: el core no exporta un chequeo de fuga (sólo está en `team.test.ts`), así que
   `teamLeakCheck` vive en `scripts/lib/team-export.ts` (hex ≥ 16, ULID, UUID, rutas, campos identificadores,
   esquema cerrado, buckets < min; offline también todo string ≥ 8 de las filas de origen). `--week` sin valor
   = semana ISO actual (UTC). Buckets por regla agregan todos los proveedores (comportamiento del core).
   No hay `cp.db` ni `token` en esta máquina, así que sólo se probó con base/servidor sintéticos.

## Ejecución

- `npx vitest run scripts/test` → **4 archivos, 31 tests OK**.
- `npx vitest run` (suite completa) → 411 OK, 1 skip, 1 FAIL ajeno: `apps/daemon/test/proxy.test.ts`
  «overhead p95 < 5 ms» (test de tiempo, sensible a carga; no toca scripts).
- `tsc --noEmit --strict` sobre los `.ts` nuevos de scripts → sin errores.
- Dry-run real `node scripts/snapshot-fixtures.mjs` (40 sesiones evaluadas, 3 elegidas, **OK**, exit 0):

  | | Archivos | Rasgos | Uso (llamadas; subagente) | Capa 2 (claves/etiquetas/valores) | Fuga |
  | --- | --- | --- | --- | --- | --- |
  | real-1 | principal 169 líneas + 2 subagentes (~2,3 MB) | subagentes, 1h, error | 81; 58 | 18 / 735 / 0 | identidad 0, patrones 0 |
  | real-2 | 129 líneas (582 KB) | 1h | 18; 0 | 6 / 937 / 0 | 0, 0 |
  | real-3 | 244 líneas (766 KB) | 1h, error | 40; 0 | 6 / 231 / 0 | 0, 0 |

  Equivalencia de uso original↔sanitizado: idéntica en las tres. Tokens sobrevivientes (601/274/352) =
  claves de esquema, ids y timestamps (muestra revisada: `answers`, `file_path`, `cache_read_input_tokens`, …).
- `npx tsx scripts/replay-transcripts.ts --top 3`: total 9 112 eventos, 266 horas activas, 104 sugerencias =
  **0,39 sugerencias por hora activa** (R1 0,11 · R2 0,12 · R5 0,09 · R3 0,06 · R4 0,02).

## Pendiente (fuera de alcance)

- Correr `node scripts/snapshot-fixtures.mjs --write`, revisar el diff y commitear (≈ 4 MB con los topes
  actuales; bajar con `--max-bytes`). Un test de core que consuma `real-<n>.expected.json` (CP-003.3).
- Trasladar la capa 2 al `sanitizeTranscriptLine` del core (ver hallazgo 1).
- ACCEPTANCE: D-7 queda resuelto en scripts salvo el commit de fixtures y fixtures web reales; D-12 resuelto.
