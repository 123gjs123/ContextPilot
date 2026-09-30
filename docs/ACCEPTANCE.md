# Aceptación — fases 0–3 (CP-001 … CP-058)

Fecha: 2026-09-30 · Commit verificado: `5b805e3` (árbol sin cambios de código; sólo se agregaron docs y `scripts/verify/*` de verificación) · Máquina: Windows 11 Pro 26200, Node 24.15.0.
Verificó: product owner / tech lead (rol `product`). Fuentes: [SPEC.md](SPEC.md), [BACKLOG.md](BACKLOG.md), [DECISIONS.md](DECISIONS.md), [API.md](API.md), [INSTALL.md](INSTALL.md), [SPIKE-desktop.md](SPIKE-desktop.md), `docs/reports/*.md`.

Regla aplicada: **PASS** sólo con evidencia (test que *asserta* el criterio, comando con salida, o lectura de código cuando el criterio es estructural). **PARTIAL** = parte del criterio sin evidencia o con desvío de comportamiento. **FAIL** = no implementado o contradicho. **NOT VERIFIABLE (NV)** = requiere sesión real / app / aprobación humana; se indica el paso exacto.

## 1. Corridas

| Comando | Resultado |
| --- | --- |
| `npx vitest run` ×5 | 5/5 verde: **39 archivos, 336 pass, 1 skipped** (el test de portapapeles real, gated por `CP_TEST_CLIPBOARD=1`). ~14 s c/u. **`ERR_IPC_CHANNEL_CLOSED` no se reprodujo** en 5 corridas (2 de ellas con un daemon de medición en paralelo). Queda como observación abierta (probable teardown del pool `forks` de vitest en Windows cuando un test mata un proceso hijo); no bloquea. |
| `npx tsc -p packages/core --noEmit` · `apps/daemon` · `apps/extension` · `apps/desktop` | 4/4 exit 0 (`strict: true`, `noUncheckedIndexedAccess`) |
| `npm run typecheck` (raíz, `tsc -b`) | **FAIL**: `error TS5083: Cannot read file 'C:/Users/fosh/contextpilot/tsconfig.json'` — no hay `tsconfig.json` raíz con `references` |
| `npm run build` (raíz) | exit 0, pero sólo corre los bundles esbuild de `extension` y `desktop` (core y daemon no tienen script `build`: no hay chequeo de tipos en el build) |
| `npm run build -w @contextpilot/extension` | exit 0 · `dist/ listo (5 bundles, manifest MV3 validado)` |
| `npm run build -w @contextpilot/desktop` | exit 0 · `[desktop] build ok` |
| `npm run smoke -w @contextpilot/desktop` | exit 0 · `SMOKE_OK tray=true overlay=true dashboard=true connection=unavailable` (sin daemon) |
| `npx tsx scripts/replay-transcripts.ts` | 5 sesiones reales más grandes, 0 errores de parseo. Disparos (con «descartar» simulado): R1 15/20/2/5/1, R2 23/28/5/9/2, R3 0/14/1/1/1, R4 4/1/0/1/1, R5 10/4/0/4/1 sobre 142/181/17/56/21 prompts. R2 es la regla más ruidosa (28 en una sesión de 181 prompts). |
| `npx tsx scripts/verify-estimator.ts` | 324 muestras: error agregado **+2,7 %**, mediana −0,2 %, p10 −6,4 %, p90 +12,8 %, **89 % dentro de ±15 %** |
| `npx tsx scripts/verify/estimator-abs.ts` *(nuevo, criterio CP-005.3 literal)* | 402 muestras (sólo texto, sin thinking, `output_tokens ≥ 200`): **mediana \|err\| 4,8 %, p90 \|err\| 17,1 %**, 87 % ≤ 15 % → cumple (≤ 15 % / ≤ 25 %) |
| `npx tsx scripts/verify/real-transcripts-usage.ts` *(nuevo, CP-030.4/.6)* | **316 transcripts reales** (104 principales + 212 de subagentes), **14 071 llamadas**, **0 excepciones, 0 archivos con diferencia**, 4 078 827 374 tokens parser = 4 078 827 374 suma independiente (**±0**). Versiones 2.1.278–2.1.285. 3,3 s |
| `node scripts/verify/no-native.mjs` *(nuevo, CP-001.3)* | OK: 5 paquetes de producción (`@contextpilot/core`, `@contextpilot/daemon`, `sql.js`, `undici`, `ws`), ningún `*.node` ni `binding.gyp` |
| `node scripts/verify/no-autosend.mjs` *(nuevo, CP-058.2)* | OK sobre `apps/extension/src` (3 `dispatchEvent`, todos `input`/`change`). Control negativo (archivo con `.click()`, `KeyboardEvent('keydown')`, `requestSubmit`) → 4 hallazgos, exit 1 |
| `node scripts/verify/idle.mjs --minutes 10 --warmup 20` | **RSS máx 90,3 MB, CPU prom. 0,4 %** (60 muestras, tailers sobre `~/.claude/projects` real con esta sesión escribiendo) → ok, margen de RAM 10 % |
| `node scripts/with-ca.mjs -- node -e "fetch('https://registry.npmjs.org')…"` | `200`. Control sin `with-ca` (sin `NODE_OPTIONS` ni `NODE_EXTRA_CA_CERTS`) también `200`: hoy el proxy TLS no intercepta, el control no discrimina |
| Daemon bajo `with-ca` (home temporal, puerto 47874) | `/health` → `{"name":"env","status":"ok","detail":"extraCa=true; httpsProxy=false; version=0.1.0"}` |

### Ejercicio real del daemon (sin efectos laterales)

Daemon `node --import tsx apps/daemon/src/main.ts`, `CONTEXTPILOT_HOME=<temp>`, puerto 47871, `CONTEXTPILOT_CLAUDE_BIN=none`, leyendo `~/.claude/projects` real en sólo lectura. Script: `…/scratchpad/live.mjs` (no versionado). Detenido al final (puerto cerrado verificado; `netstat` sin listeners 478xx).

| Paso | Resultado |
| --- | --- |
| Arranque → `/health` 200 | 456 ms. `claude-code=ok v2.1.284`, `claude-plan-usage=ok v2`, `codex=no-data (sin directorio …\.codex\sessions)`, `gemini-cli=no-data (sin …\.gemini\telemetry.log)`, `proxy/hooks/web/desktop=no-data`, `env=ok (extraCa=false)` |
| `netstat -ano` | único listener `TCP 127.0.0.1:47871 LISTENING` |
| Sin token / Origin ajeno | 401 con cuerpo vacío / 403 |
| `/sessions?active=true` | 1 sesión activa (esta): `claude-opus-5-5`, ctx 28 %, cache 99 %, ventana 1 000 000 (`windowSource=observed`) |
| `/statusline/<id>` | `ctx 28% · cache 99% · ⚠ Para` en 2,6 ms (**defecto D-3**: el «⚠» muestra la primera palabra del texto a copiar de R5); sesión desconocida → `ContextPilot: sin datos` 3,5 ms. `scripts/statusline.mjs` real → misma línea, 76 ms, exit 0 |
| `/stats` | claves `byRule, byProvider, acceptanceRate, suggestionsPerActiveHour, advisor, advisorTokens, planUsage`; `planUsage {fiveHourPct 0.37, sevenDayPct 0.36, stale false}` |
| WS `/stream` + `POST /ingest/events` web sintético (85k ≈) | 202 `accepted 1`; **W1 `warn` con acción `handoff` recibido por WS en 15,3 ms**; statusline web `ctx ≈43% · ⚠ traspaso` |
| 3 eventos `regenerated` (plan-usage desactivado) | W3 `info`, acción `copy` |
| Prompt web estimado tras 60 min de pausa | 0 sugerencias (R2 exige exacto) ✓ |
| Evento sin `sessionId` | 400 `{index:0, field:"sessionId"}` |
| Feedback `dismissed` | 200 y `suggestion-cleared` con `feedback:dismissed` por WS |
| `POST /handoff` web con `content` | `method: extractive`, 305 caracteres, secciones fijas |
| `POST /handoff` de la sesión CLI real | 200, `extractive`, `command:/clear`, 3 657 caracteres, 33 ms, 5 secciones |
| `/config/export` · `/team/export` | sin token; export de equipo sin hex ≥ 16, UUID ni rutas (4 buckets suprimidos) |
| Daemon caído: `hook.mjs` ×5 | exit 0, sin salida, **63–79 ms** (arranque de node ≈ 32–46 ms) |
| Daemon caído: `statusline.mjs` ×5 | `ContextPilot: sin datos`, exit 0, **64–68 ms** |
| Append a transcript → sugerencia R1 por WS (daemon aparte sobre carpeta temporal, 50 sesiones) | **p50 27,6 ms · p95 39,1 ms · máx 40,2 ms**, 0 timeouts |
| Mismo experimento con `plan-usage-history.json` real activo | **50/50 timeouts de R1**: R10 (`warn`, «llegás al límite a las 12:58», dato real de Claude Desktop 37 % de la ventana 5 h) se publica en cada sesión nueva y ocupa el único lugar visible; R1 a 65 % es `info` y queda encolada → **defecto D-1** |
| Config inválida en disco (`rules.R1.enabled:"si"`) | arranca; `/health` `config: error (config.json inválido: rules.R1.enabled: booleano)`; config efectiva = defaults |
| `POST /config/import?dryRun=true` con config v0 (`contentOptIn`) | migra a `storeContent.web=true`, `schemaVersion 1`, no aplica |

**No se hizo**: tocar `~/.claude/settings.json`, instalar hooks/statusline reales, abrir Claude Desktop, cargar la extensión en un navegador, correr `claude -p`, ni el test de portapapeles real. Una lectura estática de los fuses de `claude.exe` fue denegada por la política del entorno; CP-042 se acepta sobre el informe del spike.

## 2. Criterios por historia

Referencias a tests: `core/` = `packages/core/test/`, `daemon/` = `apps/daemon/test/`, `desktop/` = `apps/desktop/test/`, `ext/` = `apps/extension/test/`. «Live» = ejercicio real de §1.

### E0 — Fundaciones

| Historia | Crit. | Estado | Evidencia |
| --- | --- | --- | --- |
| CP-001 | 1 | PASS | `npm test` = `vitest run`: 39 archivos de los 4 workspaces, exit 0 (×5) |
| CP-001 | 2 | PARTIAL | `tsc -p <ws> --noEmit` limpio en los 4 (strict). Pero `npm run build` no corre tsc y `npm run typecheck` (`tsc -b`) falla TS5083 (sin `tsconfig.json` raíz) |
| CP-001 | 3 | PASS | `scripts/verify/no-native.mjs` (nuevo) → OK |
| CP-002 | 1 | PASS | `with-ca … fetch` → `200` (control sin `with-ca` también 200: hoy no hay intercepción TLS) |
| CP-002 | 2 | PASS | `%LOCALAPPDATA%\ContextPilot\ca.pem` 137 442 B existe; `NODE_EXTRA_CA_CERTS` sólo en el hijo (`scripts/with-ca.mjs`), nada instalado |
| CP-002 | 3 | PASS | Live: daemon bajo `with-ca` → `env: extraCa=true` |
| CP-003 | 1 | FAIL | `scripts/verify/snapshot-fixtures.mjs` no existe. Hay 1 transcript real sanitizado + 1 subagente (`core/fixtures/claude-code/`), no ≥ 3; `sanitizeTranscriptLine` probado en `core/parsers/claudeCode.test.ts:122` |
| CP-003 | 2 | FAIL | No existe harness `replay(fixtureDir,{speed})`. La línea partida se prueba escribiendo directo (`daemon/tailer.test.ts:50`) |
| CP-003 | 3 | PARTIAL | `*.expected.json` para Codex, Gemini OTel (`core/fixtures`), SSE claude.ai y chatgpt.com (`ext/fixtures`). Faltan Claude Code (se valida por suma independiente), DOM gemini y proxy (valores inline en `core/parsers/sse.test.ts`). Todos los web son **sintéticos** |
| CP-058 | 1 | PASS | (a)(c) proxy: body de respuesta byte a byte y pedido saliente idéntico `daemon/proxy.test.ts:129-151`; (b)(c) fetch: mismo `Response` y bytes idénticos, mismos argumentos `ext/fetchWrapper.test.ts:42,65,96` |
| CP-058 | 2 | PASS | `scripts/verify/no-autosend.mjs` (nuevo) → OK; control negativo detecta 4 patrones |

### E1 — Core

| Historia | Crit. | Estado | Evidencia |
| --- | --- | --- | --- |
| CP-004 | 1 | PASS | `core/validate.test.ts:23` (nombra `sessionId` y `tokens.estimated`), `:33` |
| CP-004 | 2 | PASS | `core/validate.test.ts:71`; `core/engine.test.ts:118` |
| CP-004 | 3 | PASS | `expectAllValid` sobre salida de parsers Claude Code/Codex/Gemini (`core/parsers/*:70/76/79`), eventos web `ext/turnEvent.test.ts:81`. No es un test genérico sobre todos los `*.expected.json`, pero cubre todos los parsers |
| CP-005 | 1 | PASS | `ext/turnEvent.test.ts:17` (`estimated:true`, conteos = `estimateTokens`); `desktop/cdp.test.ts:71` |
| CP-005 | 2 | PASS | `core/parsers/claudeCode.test.ts:48,57`; `core/parsers/codex.test.ts:26`; `core/parsers/sse.test.ts:33-59` |
| CP-005 | 3 | PASS | `scripts/verify/estimator-abs.ts`: mediana 4,8 %, p90 17,1 % (402 muestras reales). No reproducible en CI (el fixture es placeholder) |
| CP-005 | 4 | PASS | `core/misc.test.ts:19` |
| CP-006 | 1 | PASS | hash sobre texto normalizado `ext/turnEvent.test.ts:17` (`promptHashOf('  explicame   índices ')`); campos desconocidos descartados `core/validate.test.ts:54` |
| CP-006 | 2 | PASS | `core/misc.test.ts:28` (8 tipos), `:46` |
| CP-006 | 3 | PASS | Fuga sobre `cp.db`: `daemon/storage.test.ts:114`, `daemon/pipeline.test.ts:155`, `daemon/handoff.test.ts:106`. Usa contenido sintético, no «todos los fixtures» |
| CP-007 | 1 | PASS | `core/state.test.ts:9` (contextSize, cacheRatio, acumulados, `lastIdleMs`); `contextPct` vía `toView` |
| CP-007 | 2 | PASS | `core/state.test.ts:79` (`[1m]`, override, default con `windowSource`) |
| CP-007 | 3 | PASS | `core/state.test.ts:40`; `core/parsers/claudeCode.test.ts:101`; `daemon/tailer.test.ts:50` |
| CP-007 | 4 | PARTIAL | Reinicio sin duplicar `daemon/tailer.test.ts:99`, rachas `daemon/pipeline.test.ts:69`; no hay comparación profunda del estado antes/después |
| CP-008 | 1 | PASS | `core/engine.test.ts:37` |
| CP-008 | 2 | PASS | `core/engine.test.ts:41`; `core/rules.test.ts:114,285` |
| CP-008 | 3 | PASS | `core/engine.test.ts:46,57` |
| CP-008 | 4 | PASS | `core/engine.test.ts:186` p99 < 20 ms sobre 1000 eventos (sintéticos; el SPEC tiene 16 reglas, el «17» del backlog era un error) |
| CP-008 | 5 | PASS | `core/engine.test.ts:53` |
| CP-009 | 1 | PASS | `core/engine.test.ts:66` |
| CP-009 | 2 | PASS | `core/engine.test.ts:76,85` |
| CP-009 | 3 | PASS | `core/engine.test.ts:90` |
| CP-009 | 4 | PASS | `core/engine.test.ts:110` |
| CP-010 | 1 | PARTIAL | Comandos por cliente OK `core/rules.test.ts:64`; pero R1 emite **`info`** entre 60 y 80 % (`packages/core/src/rules/cli.ts:30`), el criterio pide `warn`; test no asserta severidad |
| CP-010 | 2 | PASS | `core/rules.test.ts:75` |
| CP-010 | 3 | FAIL | No hay foco: `compactCommand(event.source)` se llama sin `focus` (`rules/cli.ts:28`); payload siempre `/compact` |
| CP-010 | 4 | PARTIAL | Umbral 10 001/10 000 `core/rules.test.ts:164`; la acción es `copy` de un texto genérico, no `show-detail` con ejemplo según la herramienta |
| CP-011 | 1 | PASS | Temporizador a 5 min + 1 s, una vez `daemon/pipeline.test.ts:110`; acciones `handoff`+`/clear` `core/rules.test.ts:94`; TTL desde `ephemeral_*` `core/parsers/claudeCode.test.ts:57` |
| CP-011 | 2 | PASS | `core/rules.test.ts:102` |
| CP-011 | 3 | PASS | `core/rules.test.ts:109`; `daemon/pipeline.test.ts:123` |
| CP-011 | 4 | PASS | `core/rules.test.ts:94` (evento `prompt` con idle > TTL) |
| CP-011 | 5 | PASS | `core/rules.test.ts:114`; live (prompt web estimado tras 60 min → 0 sugerencias) |
| CP-012 | 1 | PARTIAL | `critical` `core/rules.test.ts:202`; `show-detail` sí, pero el detalle no incluye comando ni 3 timestamps (`rules/cli.ts:203-208`) |
| CP-012 | 2 | PASS | `core/rules.test.ts:206` |
| CP-012 | 3 | PASS | `desktop/notify-actions.test.ts:7` (critical → notifica); Codex → R8 `core/parsers/codex.test.ts:55` |
| CP-013 | 1 | PASS | `core/rules.test.ts:240`; `warn` verificado en live |
| CP-013 | 2 | PASS | `core/rules.test.ts:245` |
| CP-013 | 3 | PASS | `core/rules.test.ts:262`. Acción `copy` (plantilla) en vez de `show-detail`: desvío aceptado (DECISIONS 2026-09-30 «aceptación») |
| CP-014 | 1 | PASS | `core/engine.test.ts:127` |
| CP-014 | 2 | PASS | `core/engine.test.ts:127` |
| CP-014 | 3 | PASS | `core/engine.test.ts:146`; banner/tray ocultan `quiet` `ext/banner.test.ts:92`, `desktop/store.test.ts:65` |
| CP-015 | 1 | PARTIAL | `core/rules.test.ts:129,137` (sólo asserta modelo). Diff de herramientas implementado, **hash de system prompt no** |
| CP-015 | 2 | PASS | `core/rules.test.ts:133` |
| CP-015 | 3 | FAIL | Unitario 20/19 pasa (`core/rules.test.ts:179`), pero **R6 es inalcanzable en producción**: `sources` = CLI (`rules/cli.ts:138`) y sólo el proxy carga `toolsAvailable` (`apps/daemon/src/proxy.ts:179`); Claude Code no produce definiciones. Health no informa «R6 no evaluable» |
| CP-016 | 1 | PARTIAL | `core/rules.test.ts:191`. El `tier: top` sale de la tabla de core (`models.ts`), no es configurable |
| CP-016 | 2 | PASS | `core/rules.test.ts:194` |
| CP-016 | 3 | PASS | `core/rules.test.ts:270` |
| CP-017 | 1 | PASS | `core/rules.test.ts:214` |
| CP-017 | 2 | PARTIAL | Misma conversación `core/rules.test.ts:253`. El conteo de adjuntos es por sesión (`state.ts:81`): **no detecta la re-subida en otra conversación** ni ventana de 7 días |
| CP-017 | 3 | PASS | Sólo `blocks[].hash`/`tokens` persisten; `validate.test.ts:54`, fuga `daemon/storage.test.ts:114` |
| CP-018 | 1 | FAIL | Ritmo y hora de agotamiento no se exponen en estado ni API (sólo dentro del texto de R10) |
| CP-018 | 2 | PARTIAL | Hora hh:mm `core/rules.test.ts:223`; severidad `critical` sólo si faltan < 30 min, si no `warn` (`rules/other.ts:68`) → casi nunca notifica. `critical` con plan-usage `daemon/planUsage.test.ts:40` |
| CP-018 | 3 | FAIL | No hay replay de 5 h ni medición de error de proyección |
| CP-018 | 4 | PARTIAL | Rama USD implementada (`rules/other.ts:74-88`), sin test |
| CP-019 | 1 | PASS | `core/misc.test.ts:53` (dimensión fija 256); latencia medida: p99 0,67 ms sobre 1 088 caracteres; tabla `embeddings` guarda sólo vector (`apps/daemon/src/storage.ts:35`) |
| CP-019 | 2 | FAIL | No existe `fixtures/r4/cases.json` (100 casos); sólo 2 casos en `core/rules.test.ts:147,153` |
| CP-019 | 3 | PARTIAL | `open-session` + `copy /clear`; **falta `handoff`** (`rules/other.ts:34-37`) |
| CP-019 | 4 | FAIL | `transformers.js` no implementado (sin referencias en el código) |
| CP-020 | 1 | PASS | `core/rules.test.ts:279,285` |
| CP-020 | 2 | PASS | `core/rules.test.ts:293` |
| CP-021 | 1 | PASS | `core/savings.test.ts:21-73`; `core/engine.test.ts:178` |
| CP-021 | 2 | PASS | `core/savings.test.ts:79` |
| CP-021 | 3 | PASS | `core/savings.test.ts:89`; `advisorTokens=1500` `daemon/handoff.test.ts:106`; live `/stats.advisor.ratioToSaved` |

### E2 — Daemon

| Historia | Crit. | Estado | Evidencia |
| --- | --- | --- | --- |
| CP-022 | 1 | PASS | `daemon/routes.test.ts:18`; live `netstat` sólo `127.0.0.1:47871` |
| CP-022 | 2 | PASS | `daemon/routes.test.ts:23` (64 hex, reutilizado) |
| CP-022 | 3 | PASS | `daemon/routes.test.ts:37`; live 401 cuerpo vacío |
| CP-022 | 4 | PARTIAL | 403 con Origin ajeno `daemon/routes.test.ts:49,140`; pero acepta **cualquier** `chrome-extension://*`, no el id configurado |
| CP-023 | 1 | PASS | `daemon/storage.test.ts:16` (6 tablas + versión) |
| CP-023 | 2 | PASS | `daemon/storage.test.ts:46,59,70` (1,5 s, temporal + rename, corrupto apartado) |
| CP-023 | 3 | PASS | `daemon/storage.test.ts:83,99` |
| CP-024 | 1 | PASS | `daemon/routes.test.ts:66,79`; live 202 / 400 `{index, field}` |
| CP-024 | 2 | PASS | `daemon/hooks.test.ts:117` (registro, desconocido 202 contado en health) |
| CP-024 | 3 | PASS | Live append → WS p95 **39,1 ms** (50 reps); `daemon/pipeline.test.ts:13` POST → WS p95 10,9–17,4 ms en 5 corridas. Ver D-1: con plan-usage activo R1 queda tapada por R10 |
| CP-024 | 4 | PASS | `daemon/routes.test.ts:79`; `daemon/tailer.test.ts:50` (message.id repetido) |
| CP-025 | 1 | PASS | `daemon/routes.test.ts:94`; live: fuente, cliente, modelo, contextPct, cachePct, sugerencia visible |
| CP-025 | 2 | PASS | `daemon/routes.test.ts:94` |
| CP-025 | 3 | PASS | `daemon/routes.test.ts:109,119`; `daemon/planUsage.test.ts:85` (≤ 80 col); live 2,6 ms. (Contenido del «⚠»: ver CP-045.2) |
| CP-026 | 1 | PASS | `daemon/pipeline.test.ts:13` (`hello`, `session`, `suggestion`, `suggestion-cleared`), 4401 `daemon/routes.test.ts:134`. Tipo `session` en vez de `session-state`: desvío aceptado (API.md) |
| CP-026 | 2 | PASS | `daemon/pipeline.test.ts:13` (3 clientes, misma id) |
| CP-026 | 3 | PASS | `daemon/pipeline.test.ts:13`, `daemon/routes.test.ts:129`; superficie `x-cp-surface` persistida |
| CP-027 | 1 | PASS | Live `/health` con `status`, `lastEventAt`, `formatVersion`, `detail` |
| CP-027 | 2 | PASS | `daemon/tailer.test.ts:148`; live `codex=no-data` |
| CP-027 | 3 | PARTIAL | ≥ 3 líneas malas → `error` y statusline «sin datos» `daemon/tailer.test.ts:148`; tray/panel «sin datos» `desktop/view.test.ts:36`, `ext/panelView.test.ts:62`. Versión de formato desconocida **no** pasa a `error` |
| CP-028 | 1 | PASS | `idle.mjs --minutes 10`: RSS máx 90,3 MB, CPU 0,4 % |
| CP-028 | 2 | PASS | Código: rescan 60 s, reintento de raíz 30 s, plan-usage 60 s (`tailer.ts:100,107`, `planUsage.ts:98`); sin intervalos < 1 s |
| CP-029 | 1 | PASS | Live 63–79 ms, exit 0, sin salida; `daemon/hooks.test.ts:100` (umbral del test 1 500 ms) |
| CP-029 | 2 | PASS | Live 64–68 ms; `daemon/hooks.test.ts:100` |
| CP-029 | 3 | PASS | `ext/queue.test.ts:20` (500 FIFO, reenvío) |
| CP-029 | 4 | NV | Con el daemon detenido, 3 turnos en claude.ai, chatgpt.com y gemini.google.com con la extensión cargada |

### E3–E6 — Adaptadores CLI y proxy

| Historia | Crit. | Estado | Evidencia |
| --- | --- | --- | --- |
| CP-030 | 1 | PASS | `core/parsers/claudeCode.test.ts:48` |
| CP-030 | 2 | PASS | `core/parsers/claudeCode.test.ts:48,57`; 316 transcripts reales ±0 |
| CP-030 | 3 | PASS | `core/parsers/claudeCode.test.ts:64` |
| CP-030 | 4 | PASS | Suma independiente en el test `:48` y `scripts/verify/real-transcripts-usage.ts` |
| CP-030 | 5 | PARTIAL | Tolera versión nueva y registra `formatVersion` `:72`; «faltan campos requeridos → health error» sin test |
| CP-030 | 6 | PASS | `real-transcripts-usage.ts`: 316 archivos, 14 071 llamadas, 0 excepciones, diferencia 0 |
| CP-031 | 1 | PASS | `daemon/tailer.test.ts:50` (< 1 s) |
| CP-031 | 2 | PASS | `daemon/tailer.test.ts:50` |
| CP-031 | 3 | PASS | `daemon/tailer.test.ts:99` |
| CP-031 | 4 | PASS | `daemon/tailer.test.ts:50` |
| CP-031 | 5 | PASS | `daemon/tailer.test.ts:125` (sólo reprocesa lo modificado en 30 min; más estricto que 24 h) |
| CP-032 | 1 | PASS | `daemon/hooks.test.ts:33,70` (HOME temporal) |
| CP-032 | 2 | PASS | `daemon/hooks.test.ts:33` |
| CP-032 | 3 | PASS | `daemon/hooks.test.ts:100,117`. Timeout 1 s en vez de 300 ms: desvío aceptado (pedido del lead; con daemon caído sale en ~70 ms) |
| CP-032 | 4 | PASS | `daemon/storage.test.ts:114` |
| CP-033 | 1 | PASS | `core/parsers/codex.test.ts:19,26` (fixture sintético; `input = input_tokens − cached` según DECISIONS) |
| CP-033 | 2 | PASS | `daemon/tailer.test.ts:167` |
| CP-033 | 3 | PASS | Live `codex=no-data (sin directorio …)`; log sin errores |
| CP-033 | 4 | PASS | `core/parsers/codex.test.ts:55` |
| CP-033 | 5 | NV | Bloqueado: instalar Codex CLI, correr una sesión y comparar total con `/status` |
| CP-034 | 1 | PASS | `core/parsers/geminiTelemetry.test.ts:27,29,40` (sintético) |
| CP-034 | 2 | PASS | `daemon/tailer.test.ts:205`; equivalencia OTLP = archivo `core/parsers/geminiTelemetry.test.ts:56` |
| CP-034 | 3 | FAIL | `scripts/install-gemini-telemetry.mjs` no existe (INSTALL.md §7 lo documenta a mano) |
| CP-034 | 4 | PASS | `daemon/tailer.test.ts:148`; live |
| CP-034 | 5 | NV | Bloqueado: instalar Gemini CLI con `telemetry.outfile` y correr una sesión |
| CP-035 | 1 | PARTIAL | Anthropic streaming completo `daemon/proxy.test.ts:129,193`; OpenAI sólo pass-through de 429 `:204`; Google sin prueba a nivel daemon |
| CP-035 | 2 | PASS | `daemon/proxy.test.ts:160`: primer byte p95 1,72–2,60 ms, por chunk +0,42–0,86 ms (5 corridas), bytes idénticos `:129` |
| CP-035 | 3 | PARTIAL | `x-api-key` ausente de todo el home `daemon/proxy.test.ts:225`; `Authorization` y `x-goog-api-key` sin test |
| CP-035 | 4 | PARTIAL | `EnvHttpProxyAgent` (`proxy.ts:73`), sin test; live `httpsProxy=false` |
| CP-035 | 5 | PASS | INSTALL.md §8 «Limitación (RNF-08)» (no hay README; INSTALL cumple el rol) |
| CP-035 | 6 | NV | `ANTHROPIC_BASE_URL=http://127.0.0.1:47800/proxy/anthropic claude -p "hola"` con el daemon corriendo |
| CP-036 | 1 | PASS | Extractores de los 4 formatos `core/parsers/sse.test.ts:33-104`; evento exacto de proxy `daemon/proxy.test.ts:129,193` |
| CP-036 | 2 | PARTIAL | Tee y `health=error` en `catch` (`proxy.ts:130,185`); sin test de extractor que lanza |
| CP-036 | 3 | PASS | `daemon/proxy.test.ts:129` (`X-CP-Session`), `:193` (derivado `proxy:anthropic:…`) |

### E7 — Extensión: captura

| Historia | Crit. | Estado | Evidencia |
| --- | --- | --- | --- |
| CP-037 | 1 | PASS | `ext/manifest.test.ts:16,39`; build valida el manifest |
| CP-037 | 2 | PARTIAL | Código en `src/bg/daemon.ts`, `src/bg/stream.ts`; sin test de `chrome.storage`/WS/POST con token |
| CP-037 | 3 | PASS | `ext/queue.test.ts:14,20` |
| CP-037 | 4 | NV | Cargar `apps/extension/dist` sin empaquetar en Chrome y Edge, pegar el token → opciones «Conectado ✓» |
| CP-038 | 1 | PASS | `ext/fetchWrapper.test.ts:42,65,96` |
| CP-038 | 2 | PASS | `ext/controller.test.ts:47,81`, `ext/webFixtures.test.ts`, `ext/turnEvent.test.ts:17`. **Fixtures sintéticos** |
| CP-038 | 3 | PASS | `ext/fetchWrapper.test.ts:83` |
| CP-038 | 4 | NV | 3 turnos reales en claude.ai y chatgpt.com → 3 eventos en `GET /sessions/<sitio>:<id>`; re-grabar fixtures reales |
| CP-039 | 1 | PASS | `ext/geminiDom.test.ts:46,80,92` |
| CP-039 | 2 | PASS | `ext/geminiDom.test.ts:108`; selectores en `src/sites.ts` con `SELECTORS_VERSION` (desvío aceptado) |
| CP-039 | 3 | NV | 3 turnos reales en gemini.google.com → 3 eventos |
| CP-040 | 1 | PASS | `ext/controller.test.ts:144,157` |
| CP-040 | 2 | PASS | `ext/controller.test.ts:81` |
| CP-040 | 3 | PASS | `ext/controller.test.ts:105` |
| CP-040 | 4 | NV | Quitar el content script MAIN de `dist/manifest.json`, recargar; los 3 sitios siguen reportando turnos |
| CP-041 | 1 | PASS | `ext/handoff.test.ts:88` |
| CP-041 | 2 | PASS | `ext/handoff.test.ts:58,73,88` (sin submit/Enter/click) |
| CP-041 | 3 | NV | En los 3 sitios, «Generar resumen» abre chat nuevo con el traspaso pegado, editable y sin enviar |

### E8 — Desktop (CDP)

| Historia | Crit. | Estado | Evidencia |
| --- | --- | --- | --- |
| CP-042 | 1 | PASS | `docs/SPIKE-desktop.md` (versión, stack, fuses `010011011`, switch rechazado con exit 1, endpoints, recomendación). ChatGPT Desktop no instalado. Parser de fuses `desktop/misc.test.ts:12` |
| CP-042 | 2 | PASS | Escalado (ver §5, decisión H-1) |
| CP-043 | 1 | PASS | `desktop/cdp.test.ts:63-109` |
| CP-043 | 2 | PARTIAL | `no-data` + reintento 60 s implementado; sin test |
| CP-043 | 3 | PASS | `desktop/cdp.test.ts:116` |
| CP-043 | 4 | NV | Bloqueado: Claude Desktop 2.16120 rechaza `--remote-debugging-port` salvo `CLAUDE_CDP_AUTH` firmado por Anthropic |
| CP-044 | 1 | PASS (won't) | Spike: sin app ni vía sin MITM → cerrar `won't` (pendiente confirmación humana, H-1) |

### E9–E11 — UIs

| Historia | Crit. | Estado | Evidencia |
| --- | --- | --- | --- |
| CP-045 | 1 | PASS | `daemon/hooks.test.ts:117`; live `statusline.mjs` → línea real |
| CP-045 | 2 | PARTIAL | Formato y `≈` `daemon/planUsage.test.ts:85`. **Defecto D-3**: con R5 visible imprime `⚠ Para` (primera palabra de la indicación a copiar) — `statuslineText` toma el payload de `copy` como «acción corta» |
| CP-045 | 3 | PASS | Live 64–68 ms «ContextPilot: sin datos»; `daemon/hooks.test.ts:100` |
| CP-045 | 4 | PASS | `daemon/hooks.test.ts:33` (no pisa ajena sin `--force`, backup) |
| CP-045 | 5 | NV | `node scripts/install-hooks.mjs --statusline` en el `settings.json` real y abrir una sesión (decisión H-2) |
| CP-046 | 1 | PASS | `desktop/store.test.ts:19-87` |
| CP-046 | 2 | PARTIAL | `copy → accepted` `desktop/notify-actions.test.ts:40`; «Ignorar»/«Posponer 15 min» cableados en `renderer/overlay.ts:41-42`, sin test |
| CP-046 | 3 | PASS | `desktop/notify-actions.test.ts:57` |
| CP-046 | 4 | PASS | `desktop/view.test.ts:36,51` |
| CP-046 | 5 | NV | `npm run start -w @contextpilot/desktop` con daemon: ícono en bandeja, clic → overlay, copiar/ignorar/posponer |
| CP-047 | 1 | PASS | `desktop/notify-actions.test.ts:7,20` |
| CP-047 | 2 | PASS | `desktop/notify-actions.test.ts:14` |
| CP-047 | 3 | NV | Provocar R8 (3 fallos iguales) y ver el toast; clic abre el overlay en esa sugerencia |
| CP-048 | 1 | PARTIAL | `ext/banner.test.ts:42,63`: verificación **estructural** (hermano previo del contenedor, `position: static`); jsdom no calcula cajas |
| CP-048 | 2 | PASS | `ext/banner.test.ts:42` (compositor intacto), `:77` (sin submit/keydown) |
| CP-048 | 3 | PASS | `ext/banner.test.ts:77` + cooldown del motor `core/engine.test.ts:66` |
| CP-048 | 4 | NV | Ver el banner en los 3 sitios, tema claro y oscuro, sin tapar el compositor |
| CP-049 | 1 | PASS | `ext/badge.test.ts:5` (49,9/50/75/75,1) |
| CP-049 | 2 | PARTIAL | Render `ext/panelView.test.ts:37`; persistencia de toggles por `PUT /config` sin test |
| CP-049 | 3 | PASS | `ext/badge.test.ts:23`; `ext/panelView.test.ts:62` |
| CP-049 | 4 | NV | Clic en el ícono abre el side panel en Chrome y Edge |

### E12–E15 — Dashboard, traspaso, configuración, equipo

| Historia | Crit. | Estado | Evidencia |
| --- | --- | --- | --- |
| CP-050 | 1 | PASS | `desktop/misc.test.ts:92,100` |
| CP-050 | 2 | PARTIAL | Panel de salud sin test (sólo capturas del ingeniero) |
| CP-050 | 3 | PASS | `desktop/stats-csv.test.ts:64` |
| CP-050 | 4 | NV | Abrir el dashboard desde el tray con datos reales |
| CP-051 | 1 | PASS | `daemon/routes.test.ts:195`; `desktop/stats-csv.test.ts:21,30,37`; live `/stats` |
| CP-051 | 2 | PASS | `desktop/stats-csv.test.ts:50` |
| CP-051 | 3 | PASS | `desktop/stats-csv.test.ts:76,95` |
| CP-051 | 4 | NV | Revisión visual con 1 semana de datos |
| CP-052 | 1 | PASS | `daemon/handoff.test.ts:61,106`; live sesión real: 5 secciones, 3 657 caracteres (≈ 900 tokens) |
| CP-052 | 2 | PASS | `daemon/handoff.test.ts:106` (`claude` falso con `-p haiku json`, fallback extractivo) |
| CP-052 | 3 | PASS | `daemon/handoff.test.ts:106` |
| CP-052 | 4 | PASS | `daemon/handoff.test.ts:61,76` |
| CP-052 | 5 | NV | Traspaso real con `claude -p --model haiku` y juicio del usuario |
| CP-053 | 1 | NV | Test gated no corrido (toca el portapapeles): `$env:CP_TEST_CLIPBOARD=1; npx vitest run apps/daemon/test/handoff.test.ts` (el ingeniero reporta verde) |
| CP-053 | 2 | PASS | `daemon/handoff.test.ts:167` |
| CP-054 | 1 | PASS | `daemon/routes.test.ts:148` |
| CP-054 | 2 | PASS | `daemon/routes.test.ts:163`; `core/engine.test.ts:53` |
| CP-054 | 3 | PASS | `daemon/routes.test.ts:148` (`storeContent` todo `false`), `daemon/storage.test.ts:114` |
| CP-054 | 4 | PARTIAL | Live: config inválida → health `config: error`, pero usa **defaults**, no la última válida |
| CP-055 | 1 | PARTIAL | Validación `daemon/routes.test.ts:172`, `desktop/config-team.test.ts:38`. Sólo una ventana (`windowMs`/`windowBudgetTokens`); no el formato `windows: [{hours},{days}]` (5 h + 7 días) |
| CP-055 | 2 | PASS | `desktop/config-team.test.ts:56` |
| CP-055 | 3 | PARTIAL | Sin plan R10 no evalúa `core/rules.test.ts:229`; pero con `plan-usage-history.json` presente R10 se evalúa aunque el usuario no tenga perfil (desvío no registrado) |
| CP-056 | 1 | PASS | `daemon/routes.test.ts:177`; live |
| CP-056 | 2 | PASS | dry-run `daemon/routes.test.ts:177`, diff en desktop `desktop/config-team.test.ts:61`, migración v0 live |
| CP-057 | 1 | PARTIAL | `scripts/team-export.mjs` no existe; existe `GET /team/export` (`daemon/routes.test.ts:205`) con agregados de `core/team.test.ts:30` |
| CP-057 | 2 | PASS | `core/team.test.ts:39,44`; `daemon/routes.test.ts:205`; live |
| CP-057 | 3 | PASS | `desktop/config-team.test.ts:93,106`; `core/team.test.ts:61` |
| CP-057 | 4 | NV | Aprobación de seguridad registrada en DECISIONS.md (H-3) |

### Totales de criterios

| Estado | Criterios |
| --- | --- |
| PASS | 149 (incluye CP-044.1 «won't» confirmado por el spike) |
| PARTIAL | 30 |
| FAIL | 9 |
| NOT VERIFIABLE | 20 |
| **Total** | **208** (= criterios del backlog) |

### Estado por historia (volcado a BACKLOG.md)

| Estado | N | Historias |
| --- | --- | --- |
| done | 21 | CP-002, 004, 005, 006, 008, 009, 011, 013, 014, 020, 021, 023, 024, 025, 026, 028, 031, 032, 042, 056, 058 |
| partial — AUTO completo, sólo falta MANUAL | 10 | CP-029, 033, 038, 039, 040, 041, 047, 051, 052, 053 |
| partial — con PARTIAL/FAIL en criterios AUTO | 25 | CP-001, 003, 007, 010, 012, 015, 016, 017, 018, 019, 022, 027, 030, 034, 035, 036, 037, 045, 046, 048, 049, 050, 054, 055, 057 |
| blocked | 1 | CP-043 (CDP rechazado por Claude Desktop) |
| won't | 1 | CP-044 (provisorio, confirma el humano) |

## 3. Veredicto por fase (SPEC §10)

| Fase | Criterio del SPEC | Resultado | Evidencia |
| --- | --- | --- | --- |
| 0 | Eventos de 3 CLIs y 3 sitios | **NO CUMPLIDO (verificable sólo en parte)** | Claude Code real ✓. Codex y Gemini CLI: sólo fixtures sintéticos (no instalados). 3 sitios: sólo fixtures sintéticos y jsdom; ninguna sesión real |
| 0 | Tokens CLI = `usage` (±0 %) | **CUMPLIDO** (Claude Code) | 316 transcripts, 14 071 llamadas, diferencia 0. Codex/Gemini ±0 sólo contra fixtures |
| 0 | Estimación web ±15 % | **PARCIAL** | Estimador contra `output_tokens` reales: mediana \|err\| 4,8 %, p90 17,1 %, agregado +2,7 %. No hay verdad de terreno web (el `input` web depende del texto visible en el DOM) |
| 0 | Sugerencia < 1 s | **CUMPLIDO** | append → WS p95 39 ms; POST → WS p95 11–17 ms. Con el matiz D-1 (R10 tapa a R1) |
| 0 | Cero pedidos modificados | **CUMPLIDO** | CP-058.1/.2 |
| **0** | **Veredicto** | **No aceptada todavía.** El núcleo AUTO está sólido, pero faltan la verificación real de la extensión en los 3 sitios (CP-037.4, 038.4, 039.3, 041.3, 048.4, 049.4), los hooks/statusline reales (H-2) y hay defectos que afectan CU-01 (D-1, D-2, D-3) | |
| 1 | Proxy < 5 ms | **CUMPLIDO** | primer byte p95 1,7–2,6 ms, por chunk +0,4–0,9 ms (upstream local) |
| 1 | Proyección < 20 % de error en 5 h | **NO CUMPLIDO** | CP-018.3 sin replay ni medición; ritmo/proyección no expuestos (CP-018.1) |
| 1 | Informe de spike | **CUMPLIDO** | `docs/SPIKE-desktop.md` |
| **1** | **Veredicto** | **No aceptada.** Falta el criterio de proyección; R6 no funciona en producción (D-4); proxy verificado sólo para Anthropic de punta a punta | |
| 2 | R4 precisión > 80 % sobre 100 casos | **NO CUMPLIDO** | No existe el dataset (CP-019.2) |
| 2 | Desktop health verde 5 días | **BLOQUEADO** | Claude Desktop rechaza CDP (H-1) |
| **2** | **Veredicto** | **No aceptada.** R4 sin medición, `transformers.js` ausente, adaptador desktop inviable sin decisión humana. G1/G2 y export/import sí están | |
| 3 | Nada de contenido ni hashes sale de la máquina | **CUMPLIDO (AUTO)** | Fuga `core/team.test.ts:44`, `daemon/routes.test.ts:205`, live |
| 3 | Aprobación de seguridad | **PENDIENTE (humano)** | H-3 |
| **3** | **Veredicto** | **No aceptada hasta la aprobación de seguridad**; además falta `scripts/team-export.mjs` (CP-057.1) | |

## 4. Defectos y huecos priorizados

| # | Prioridad | Historias | Defecto / hueco | Evidencia | Arreglo esperado |
| --- | --- | --- | --- | --- | --- |
| D-1 | **Alta** | CP-018, CP-009, CP-010, CP-055 | R10 alimentado por `plan-usage-history.json` es una señal **de cuenta** pero se emite **por sesión**: aparece en cada sesión Anthropic nueva y ocupa el único lugar visible. R1 (60–80 % = `info`) no puede reemplazarla → en esta máquina **R1 nunca se ve** en ese rango (50/50 timeouts en live) | Live §1; `rules/other.ts:42-92`; `rules/cli.ts:30` | R10 global (una por proveedor, fuera del cupo por sesión) o con menor prioridad que las reglas de sesión; registrar el uso de plan-usage sin perfil en DECISIONS |
| D-2 | **Alta** | CP-010 | R1 (CU-01, el caso de uso principal) emite `info` entre 60 y 80 % y **sin foco**: siempre `/compact` pelado | `rules/cli.ts:28-30` | `warn` desde 60 %; foco con archivos/herramientas de los últimos 5 turnos |
| D-3 | **Alta** | CP-045 | Statusline muestra `⚠ Para` cuando la sugerencia visible es R5 (toma la primera palabra del texto a copiar) | Live `/statusline` y `statusline.mjs` | «Acción corta» por regla (`/compact`, `traspaso`, `grep/head`, …), no el payload |
| D-4 | **Alta** | CP-015 | R6 inalcanzable: `sources` = CLI y sólo el proxy aporta `toolsAvailable`; Claude Code no carga definiciones (contra DECISIONS «R6») | `rules/cli.ts:138`, `proxy.ts:179` | Agregar `proxy` a `sources` y extraer MCP/herramientas para Claude Code, o declarar R6 sólo-proxy y mostrarlo en health |
| D-5 | **Alta** | CP-018 | Sin exposición de ritmo/proyección (18.1) ni medición de error a 5 h (18.3): criterio de fase 1 sin evidencia | — | Campo `burn` en `SessionView`/`/stats`; replay de 5 h (se puede derivar de `plan-usage-history.json`) |
| D-6 | **Alta** | CP-019 | Sin dataset de 100 casos (criterio de fase 2), sin `handoff` en R4, sin `transformers.js` | — | Crear `fixtures/r4/cases.json` etiquetado, test de precisión |
| D-7 | Media | CP-003 | Falta `snapshot-fixtures.mjs` y harness `replay()`; 1 solo transcript real sanitizado; fixtures web **todos sintéticos** | — | Implementar; re-grabar fixtures web en sesión real |
| D-8 | Media | CP-001 | `npm run typecheck` roto (TS5083) y `npm run build` no chequea tipos de core/daemon | §1 | `tsconfig.json` raíz con `references`, o `typecheck` = tsc por workspace |
| D-9 | Media | CP-022 | Acepta cualquier `chrome-extension://*` (criterio: id configurado) | `daemon/routes.test.ts:49` | Id de la extensión en config; resto 403 |
| D-10 | Media | CP-035, CP-036 | Proxy OpenAI/Google sin prueba de punta a punta; `Authorization`/`x-goog-api-key` sin test de fuga; `HTTPS_PROXY` y extractor que lanza sin test | — | Tests en `daemon/proxy.test.ts` |
| D-11 | Media | CP-017 | W2 cuenta adjuntos por conversación: no detecta la re-subida en otra conversación (el caso real de W2) | `state.ts:81` | Índice de hashes por sitio, 7 días |
| D-12 | Media | CP-034, CP-057 | Faltan `scripts/install-gemini-telemetry.mjs` y `scripts/team-export.mjs` | — | Implementar |
| D-13 | Baja | CP-012 | Detalle de R8 sin comando ni timestamps | `rules/cli.ts:203` | Agregar |
| D-14 | Baja | CP-010, CP-015, CP-016 | R5 sin ejemplo por herramienta; R3 sin hash de system prompt; `tier` no configurable | — | — |
| D-15 | Baja | CP-054, CP-055 | Config inválida → defaults (no la última válida); plan con una sola ventana (no 5 h + 7 días) | Live | — |
| D-16 | Baja | CP-007, CP-027, CP-030, CP-037, CP-043, CP-046, CP-049, CP-050 | Criterios implementados sin test (rehidratación profunda, versión desconocida → error, campos faltantes, `chrome.*` del SW, reintento CDP, ignorar/posponer del overlay, toggles del panel, panel de salud) | — | Tests |
| D-17 | Obs. | CP-001 | `ERR_IPC_CHANNEL_CLOSED` reportado una vez; 0/5 en esta verificación | §1 | Si reaparece: `pool: 'threads'` o cerrar hijos en `afterAll` del proxy test |
| D-18 | Obs. | R2 | R2 es la regla más ruidosa en el replay (hasta 28 disparos/181 prompts); SPEC §11 pide ≤ 3 sugerencias por hora activa | replay | Revisar al tener datos de uso (una emisión por pausa + cooldown 30 min) |

## 5. Decisiones que debe tomar el humano

| # | Decisión | Contexto | Opciones |
| --- | --- | --- | --- |
| H-1 | **Claude Desktop (CP-043) y ChatGPT Desktop (CP-044)** | Claude Desktop 2.16120 sale con código 1 ante `--remote-debugging-port` salvo token `CLAUDE_CDP_AUTH` firmado por Anthropic; fuses bloquean `--inspect`/`NODE_OPTIONS`; asar con integridad. ChatGPT Desktop no está instalado | (a) `won't` para CDP y cerrar el criterio de fase 2 «health verde 5 días» como no aplicable; (b) financiar un spike 2 de **UI Automation** (sólo lectura del árbol de accesibilidad, fuente `desktop` estimada); (c) MITM con aprobación de IT (contra RNF-11/«sin MITM en v1»). Recomendación PO: (a) + (b) acotado a 2 días; mantener `plan-usage-history.json` como señal de plan |
| H-2 | **Instalar hooks y statusline en el `~/.claude/settings.json` real** | Necesario para CP-045.5 y para cerrar la verificación real de fase 0; el instalador hace backup `.cp-bak`, es idempotente y tiene `--uninstall` (probado en HOME temporal) | Autorizar `node scripts/install-hooks.mjs --dry-run` → revisar → `node scripts/install-hooks.mjs --statusline`. Si ya hay statusline propia, decidir si se reemplaza (`--force`). Recomendación PO: primero arreglar D-3 |
| H-3 | **Aprobación de seguridad del modo equipo (CP-057.4, criterio de fase 3)** | Export sin servidor, agregados por semana/proveedor/regla, buckets < 5 sesiones suprimidos, sin ids/hashes/rutas (tests de fuga ✓) | Aprobar/rechazar y registrar en DECISIONS.md con fecha y aprobador |
| H-4 | **Aprobación de IT de la extensión** (pregunta abierta SPEC §12) | Permisos `storage`, `sidePanel`, `clipboardWrite`; hosts de los 3 sitios + `127.0.0.1:47800`; script en mundo `MAIN` que envuelve `fetch` (sólo lectura, verificado) | Aprobar carga sin empaquetar para las pruebas MANUAL de fase 0; decidir distribución (sin empaquetar / política de empresa) |
| H-5 | **Postura sobre `Origin`** (seguridad, D-9) | Hoy cualquier extensión con el token puede llamar al daemon | Exigir id configurado (recomendado) o aceptar el riesgo |
| H-6 | **Instalar Codex CLI y Gemini CLI** (o aceptar verificación sólo con fixtures) | CP-033.5, CP-034.5 y el criterio de fase 0 «eventos de 3 CLIs» | Instalar (con el proxy corporativo: `--use-system-ca`) o aceptar formalmente la limitación |
| H-7 | **Uso de `plan-usage-history.json` de Claude Desktop para R10** | Lectura sólo-lectura de un archivo interno de otra app; hoy pisa el perfil del usuario y genera D-1 | Aprobar como fuente (con D-1 corregido) o desactivar por defecto |

## 6. Pasos MANUAL pendientes (checklist)

1. H-4 → cargar `apps/extension/dist` en Chrome y Edge, pegar el token (CP-037.4, CP-049.4).
2. 3 turnos en claude.ai, chatgpt.com y gemini.google.com; `GET /sessions/<sitio>:<id>` muestra 3 eventos; re-grabar fixtures SSE/DOM reales con texto reemplazado (CP-038.4, CP-039.3, CP-003.3).
3. Desactivar el script MAIN y repetir (CP-040.4); daemon detenido y repetir (CP-029.4).
4. Bajar W1 con `PUT /config` y probar banner + traspaso en los 3 sitios, tema claro/oscuro (CP-041.3, CP-048.4).
5. H-2 → statusline real (CP-045.5); `ANTHROPIC_BASE_URL=… claude -p "hola"` (CP-035.6); traspaso real con `claude -p` (CP-052.5); `CP_TEST_CLIPBOARD=1` (CP-053.1).
6. `npm run start -w @contextpilot/desktop` con daemon: tray, overlay, toast de R8, dashboard (CP-046.5, CP-047.3, CP-050.4, CP-051.4).
