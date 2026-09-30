# Reporte — `packages/core`

Fecha: 2026-09-30. Alcance: sólo `packages/core` (+ filas nuevas en `DECISIONS.md`). Todos los cambios a exports existentes son aditivos.

## Qué se construyó

| Archivo | Contenido | Historias |
| --- | --- | --- |
| `src/validate.ts` | `validateTurnEvent` (errores con nombre de campo, completa `id`/`ts`, descarta campos desconocidos), `validateSuggestion` (≥ 1 acción), `SOURCES`, `PROVIDERS` | CP-004 |
| `src/parsers/codex.ts` | `CodexParser` para rollouts JSONL (formato `{timestamp,type,payload}` y legado), `codexSessionIdFromPath`, `parseToolOutput` | CP-033 (parser) |
| `src/parsers/geminiTelemetry.ts` | `GeminiTelemetryParser` (outfile + OTLP/HTTP JSON + logRecord suelto, dedupe de reintentos), `parseGeminiOutfile`, `GeminiOutfileSplitter` (incremental), `attrsOf` | CP-034 (parser) |
| `src/parsers/sse.ts` | `SseParser`, `createUsageExtractor`, `extractUsageFromJson` (Anthropic Messages, OpenAI Chat + Responses, Gemini SSE/JSON/array), normalizadores `anthropicUsage`/`openaiUsage`/`geminiUsage`, `requestInfo` (modelo, estimación de prompt, herramientas declaradas con costo, hashes system/primer user), `proxySessionId`, `geminiModelFromUrl` | CP-036 (extracción) |
| `src/parsers/web.ts` | `createWebStreamParser('claude.ai' \| 'chatgpt.com')`: claude.ai actual y legado; chatgpt.com acumulativo y delta encoding v1 (add/append/replace/patch/`{v}` suelto) | CP-038 (parte pura) |
| `src/parsers/sanitize.ts` | `sanitizeTranscriptLine` / `sanitizeTranscriptRecord` / `placeholder` para fixtures de transcripts reales | CP-003 (base) |
| `src/savings.ts` | `estimateSaving` por regla (horizonte 10, cacheRead ×0,1), `realizedSavings`, `advisorCostRatio`, `contextTokenWeight`, constantes | CP-021 |
| `src/team.ts` | `aggregateTeam`, `mergeTeamExports`, `isoWeek`, tipos `TeamExport` y filas | CP-057 (lógica) |
| `src/models.ts` | `contextWindowInfo(model, provider, opts?)` → `{window, source}`; Gemini 1 048 576 | CP-007.2 |
| `src/parsers/claudeCode.ts` | opciones `parentSessionId` y `sidechain`; líneas `isSidechain` → eventos `sidechain: true`; `windowSource` | CP-007.3, CP-030, CP-031.4 (parte core) |
| `src/state.ts` | `applyEvent` con rama sidechain; `windowSource` en estado y `SessionView` | CP-007 |
| `src/engine.ts` | eventos sidechain sólo evalúan R5/R8/R10; `estimatedSavingTokens` desde `savings.ts`; `mergeConfig` copia `contextWindows` | CP-008, CP-009, CP-014, CP-021 |
| `src/types.ts` | opcionales `TurnEvent.sidechain`, `TurnEvent.windowSource`, `SessionState.windowSource`, `Config.contextWindows`; tipo `WindowSource` | — |

## Tests

`npx vitest run packages/core` → **145 tests, 12 archivos, verde**. `npx tsc -p packages/core --noEmit` → limpio.

| Archivo | Tests | Cubre |
| --- | --- | --- |
| `rules.test.ts` | 34 | las 16 reglas: dispara / no dispara / sources / requiresExact (vía motor) |
| `engine.test.ts` | 17 | sources, requiresExact, override por proveedor, regla deshabilitada, cooldown, una visible + agrupación, desempate por ahorro, reemplazo por mayor severidad, snooze 15 min, racha de descartes → severidad −1 y cooldown ×2, accepted resetea, quiet, sidechain, ahorro por fórmula, p99 < 20 ms |
| `parsers/sse.test.ts` | 15 | 4 formatos SSE con chunks partidos, JSON no-stream, `requestInfo` ×3 proveedores, sessionId de proxy |
| `savings.test.ts` | 13 | fórmula por regla, ahorro realizado, cociente RNF-14 |
| `parsers/claudeCode.test.ts` | 11 | fixture sanitizado real: dedupe por `message.id` y suma de usage ±0 contra suma independiente, TTL 1 h, `is_error`, subagentes, sanitizador |
| `parsers/codex.test.ts` | 10 | `*.expected.json`, mapeo de uso, turnos/pausa, herramientas, R8 desde Codex, legado, tolerancia |
| `parsers/geminiTelemetry.test.ts` | 10 | `*.expected.json`, outfile incremental, OTLP = archivo, dedupe de reintento, tolerancia |
| `misc.test.ts` | 9 | estimador (cordura, 100k < 50 ms), redact (8 tipos), embed (similar > disímil), util, blocks |
| `state.test.ts` | 8 | `applyEvent` (incl. sidechain), pureza, `contextWindowInfo` |
| `parsers/web.test.ts` | 6 | claude.ai actual/legado/cortado, chatgpt.com delta/acumulativo/basura |
| `team.test.ts` | 6 | agregados, supresión < 5, test de fuga, rango, merge |
| `validate.test.ts` | 6 | TurnEvent y Suggestion |

Fixtures en `packages/core/test/fixtures/`: `claude-code/` (transcript real sanitizado: 80 líneas del hilo principal + 1 subagente; sin contenido real, verificado), `codex/`, `gemini-cli/`, `proxy/`, `web/` (sintéticos según formatos documentados). `*.expected.json` para Codex y Gemini (regenerables con `UPDATE_FIXTURES=1`).

## Pendientes / limitaciones

- **Formatos sin verificar contra datos reales**: Codex, Gemini CLI, los SSE del proxy y de claude.ai/chatgpt.com son sintéticos (DECISIONS «Codex y Gemini CLI no instalados»). Los sitios web cambian seguido; hay que grabar fixtures reales (CP-038 MANUAL).
- **CP-003**: falta el script `scripts/verify/snapshot-fixtures.mjs` y el harness `replay()` (fuera de `packages/core`); `sanitizeTranscriptLine` está lista para usarlo. No hay `*.expected.json` para Claude Code (se valida con suma independiente), proxy ni web (el parser web no emite `TurnEvent`; lo arma la extensión).
- **CP-005.3** (mediana/p90 del estimador sobre fixtures): no reproducible con el fixture sanitizado (el texto es placeholder); sigue cubierto por `scripts/verify-estimator.ts` sobre transcripts reales.
- **Gemini `tool_call`** no informa tamaño del resultado → `resultTokens = 0` (R5 no aplica a Gemini CLI vía telemetría).
- **R7/W4/R10** tienen ahorro 0 en tokens (su beneficio es precio/proyección).
- **CP-007.4** (rehidratación desde sql.js) y **CP-018.3/4** (error de proyección, USD) dependen del daemon/replay.
- Tests del daemon (`apps/daemon/test/pipeline.test.ts`) tenían 2 fallas al momento de correr la suite completa (formato de statusline con `cache` y vencimiento de sugerencias); los archivos del daemon se estaban editando en paralelo y las fallas no dependen de estos cambios.
