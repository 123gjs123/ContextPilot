# Reporte — `apps/daemon` + `scripts/`

Fecha: 2026-09-30. Alcance: `apps/daemon`, `scripts/` (salvo `replay-transcripts.ts` y `verify-estimator.ts`), `docs/INSTALL.md`. Sin cambios en `packages/core`; sin commits. No se tocó `~/.claude/settings.json` real.

## Qué se construyó

| Archivo | Contenido | Historias |
| --- | --- | --- |
| `src/main.ts` | Entrada: home (`CONTEXTPILOT_HOME` / `%LOCALAPPDATA%\ContextPilot`), puerto (`CONTEXTPILOT_PORT` / 47800), apagado ordenado | CP-022 |
| `src/daemon.ts` | Orquestación: token, config, storage, pipeline, adaptadores (arranque/parada en caliente), hooks, OTLP, traspaso, export de equipo, config efectiva del motor | CP-022, CP-027, CP-054 |
| `src/paths.ts` | Rutas, token de 32 bytes hex (creado una vez, reutilizado), escritura atómica | CP-022.2 |
| `src/config.ts` | `config.json` = `defaultConfig()` del core + bloque `daemon` (retención, outfile Gemini, recentMs, modelo de traspaso); validación, migración v0, merge; config inválida en disco → default + health `config: error` | CP-054, CP-055 (validación), CP-056 |
| `src/storage.ts` | sql.js: `sessions`, `turns`, `tool_calls`, `suggestions`, `embeddings`, `settings` + `meta` (versión de esquema), `offsets`, `transcripts`, `advisor_usage`, `contents` (sólo opt-in). Volcado a `cp.db` con retardo fijo 1,5 s, temporal + rename; archivo corrupto → `.corrupt-<ts>`; retención 30 días al arrancar y cada 24 h | CP-023 |
| `src/pipeline.ts` | evento → `applyEvent` → `RuleEngine.evaluate` (usageWindow por proveedor para R10) → persistir → emitir. Idempotente por `id`. Replay con reloj del evento (sólo publica sugerencias aún vigentes). Reemplazo de sugerencia visible → `suggestion-cleared`. Vencimiento → `suggestion-cleared` `expired`. **R2 proactivo**: timer por sesión al cruzar `cacheTtlMs` sin actividad, evento sintético de fase `prompt` (no persiste ni altera estado), una emisión por pausa. Rachas de descarte persistidas | CP-024, CP-026, D «R2 proactivo», RF-REG-04 |
| `src/server.ts` | `node:http` + `ws`, todas las rutas de `docs/API.md`; token con `timingSafeEqual`; Origin (sólo `chrome-extension://*`, `null`/`file://` o ausente) incluido el upgrade WS; CORS/preflight para la extensión; WS `hello`/`session`/`suggestion`/`suggestion-cleared`/`health`, feedback por WS; token inválido → cierre 4401 | CP-022, CP-025, CP-026 |
| `src/tailer.ts` | Tailer por offset de bytes (fs.watch recursivo + rescan de respaldo 60 s, sin polling < 1 s), líneas partidas, truncado, altas sin carrera; arranque: reciente sin offset → replay; con offset y reciente → re-parseo «warm» hasta el offset (reconstruye el estado del parser sin re-emitir) y sigue; viejo → offset al final | CP-031 |
| `src/adapters/cli.ts`, `jsonl.ts` | Claude Code (`projects/<p>/<sid>.jsonl` y `<sid>/subagents/*.jsonl` → `ClaudeCodeParser({ parentSessionId, sidechain: true })`) y Codex (`rollout-*.jsonl`, sessionId del nombre de archivo). Health: `ok`/`no-data`/`error` (≥ 3 líneas malas seguidas), `formatVersion` | CP-031, CP-033 (tailer), CP-027 |
| `src/adapters/gemini.ts` | Outfile (objetos JSON multilínea, corte en bytes para el offset) + OTLP/HTTP JSON vía `GeminiTelemetryParser` | CP-034 (lector) |
| `src/adapters/planUsage.ts` | **Nuevo (pedido del lead)**: lee `plan-usage-history.json` de Claude Desktop (sólo lectura, stat cada 60 s), health `claude-plan-usage`, `/stats.planUsage`, y con muestra fresca (< 45 min) inyecta al motor un plan en unidades de % para que R10 de `anthropic` proyecte sobre el dato del proveedor | CU-06 / R10 |
| `src/proxy.ts` | `/proxy/{anthropic,openai,google}/*`: undici `request` (EnvHttpProxyAgent; Agent directo para loopback), body del pedido reenviado byte a byte, respuesta en streaming sin tocar (incluye gzip/br), tee → `createUsageExtractor` (descomprime la copia si hace falta), `requestInfo` + `proxySessionId`, `X-CP-Session` no viaja al upstream, evento después de terminar la respuesta | CP-035, CP-036, CP-058(a,c) |
| `src/handoff.ts` | Lee el transcript registrado (Claude Code / Codex) o el `content` de la extensión, redacta, arma conversación compacta; `claude -p --model haiku --output-format json` (PATH o binario de la extensión de VS Code, timeout 60 s, stdin, cwd propio ignorado por el tailer); fallback extractivo determinista (objetivo, estado, decisiones, archivos, próximos pasos desde TodoWrite/TODO); consumo propio a `advisor_usage` | CP-052 |
| `src/stats.ts` | `/stats`: byRule, byProvider, acceptanceRate, suggestionsPerActiveHour, `advisor`, `advisorTokens`, `planUsage` | CP-051 (endpoint), RNF-14 |
| `scripts/hook.mjs` | Reenvía stdin a `/ingest/hooks/<Hook>` con token, timeout 1 s, siempre exit 0 sin salida | CP-032.3, CP-029.1 |
| `scripts/install-hooks.mjs` | Instala/desinstala hooks y `--statusline` (con `--force`), backup `.cp-bak`, idempotente, `--settings`, `--dry-run` | CP-032.1-2, CP-045.4 |
| `scripts/statusline.mjs` | `GET /statusline/:id` con 300 ms; falla → `ContextPilot: sin datos` | CP-045 |
| `scripts/handoff.mjs` | `<id>\|--latest` `--copy` (Set-Clipboard vía base64, UTF-8 intacto) / `--print` | CP-053 |
| `scripts/with-ca.mjs` | Exporta Root+CA de LocalMachine/CurrentUser a `ca.pem` (PowerShell `-EncodedCommand`), hijo con `NODE_EXTRA_CA_CERTS` | CP-002 |
| `scripts/verify/idle.mjs` | RSS/CPU de un daemon (propio o `--pid`) durante N s | CP-028 |
| `scripts/lib/cp.mjs` | home/puerto/token/stdin compartidos | — |

## Pedido del lead (cliente desktop)

1. Nombres de health = id de fuente (`claude-code`, `codex`, `gemini-cli`, `proxy`, `web`, `desktop`) + `hooks`, `claude-plan-usage`, `env`, `config` (si hay error). ✔
2. `GET /sessions` sin `active` → todas (memoria + últimas 200 de la base). ✔
3. Sugerencias de `/sessions/:id` incluyen `createdAt` (lo pone el motor). ✔
4. `/stats.advisorTokens`. ✔
5. `POST /config/import?dryRun=true|false`. ✔ (dry-run devuelve la Config validada sin aplicar; no devuelve diff).
6. `/team/export` = `aggregateTeam` del core (`{schema, byProvider, byRule, …}`). ✔
7. `claude-plan-usage` + `/stats.planUsage {fiveHourPct, sevenDayPct, ts, stale}` (fracciones 0..1) + R10. ✔

## Tests

`npx vitest run apps/daemon` → **8 archivos, 59 tests verdes, 1 omitido** (portapapeles real; se corrió una vez con `CP_TEST_CLIPBOARD=1`: verde, y restaura el portapapeles). Suite completa del repo: **39 archivos, 336 verdes**. `tsc -p apps/daemon` limpio.

| Archivo | Cubre |
| --- | --- |
| `routes.test.ts` (19) | sólo 127.0.0.1; token persistido/reutilizado; 401 sin cuerpo; `/health` sin token; Origin 403 / chrome-extension / null / preflight; ingesta 400 con índice y campo, 202, id/ts completados, idempotencia; sessions/timeline/404; statusline (`sin datos`, `≈`, < 50 ms); feedback 400/404; WS 4401 y 403; config GET/PUT en caliente y a disco; adaptador deshabilitado → `disabled`; plan inválido; export sin token + import dry-run/aplicado; stats; team export sin ids/hashes/rutas |
| `pipeline.test.ts` (7) | 50 × POST que cruza R1 → WS: **p95 4,8–9,2 ms** (< 1 s); statusline con `⚠ /compact`; 3 clientes reciben la misma; feedback POST y WS → `suggestion-cleared`, persistido, racha de descartes persistida y recargada; **R2 proactivo con fake timers** (una vez, reprograma con actividad, no con contexto chico); vencimiento → `expired`; replay sin sugerencias viejas; contenido sin opt-in no persiste |
| `storage.test.ts` (7) | roundtrip a disco, debounce ≤ 5 s sin temporales colgando, archivo corrupto, temporal huérfano, retención (unitaria y al arrancar), fuga: contenido/prompt de hook sin opt-in no aparecen en `cp.db`; con opt-in se guarda redactado |
| `tailer.test.ts` (7) | sesión nueva < 1 s; línea partida en dos escrituras; `message.id` repetido no duplica; subagente suma al padre sin tocar `contextSize` y no pisa el transcript registrado; reinicio desde offset sin duplicar; viejos no se reprocesan / recientes sí / append posterior sí; no-data y error por líneas basura (statusline «sin datos»); Codex contra el parser del core como oráculo; Gemini outfile partido a mitad de objeto; OTLP sin token |
| `hooks.test.ts` (4) | instalador en HOME temporal: 4 hooks, preserva ajenos, backup, idempotente, statusline no pisa ajena sin `--force`, `--uninstall`; sin settings previo. `hook.mjs` con daemon caído: exit 0, sin salida, **~60 ms**; statusline caída → `sin datos`; con daemon: registra transcript, hook desconocido → 202 contado en health, statusline real |
| `proxy.test.ts` (6) | **CP-058**: respuesta SSE byte a byte idéntica, headers (incl. `set-cookie` múltiple) preservados, pedido saliente idéntico (body, `x-api-key`, `anthropic-version`), `x-cp-session` no viaja; uso extraído (12/30500/2048/57) y `toolsAvailable`; gzip JSON idéntico + uso; 429 pasa sin evento; upstream caído → 502; Origin 403; **fuga: API key en ningún archivo del home**. Latencia contra un daemon en proceso aparte: **primer byte p95 +1,9 ms; por chunk p95 +0,5–0,8 ms** (< 5 ms) |
| `handoff.test.ts` (5+1) | extractivo determinista, secciones, redacción, archivos editados, TODOs pendientes; < 2 s sobre 40× el fixture; `claude` falso (.cmd): `method: claude-cli`, prompt redactado, `advisorTokens` = 1500; `claude` que falla → extractivo; `content` de extensión no persiste; 400/404; `handoff.mjs --print`; Set-Clipboard UTF-8 (gated) |
| `planUsage.test.ts` (4) | parser (org más reciente, reinicio de ventana), health ok, `/stats.planUsage`, R10 `critical` con la serie de %, sin filtrar el id de organización; sin archivo → no-data; `statuslineText` (formato, `≈`, quiet, ≤ 80 col) |

## Mediciones

- **RNF-07 / CP-028** (`node scripts/verify/idle.mjs --seconds 60 --warmup 15`, daemon con tailers sobre los directorios reales): **RSS máx 80,4 MB, CPU promedio 0,34 %** → ok. (Criterio del backlog es 10 min: `--minutes 10`, no corrido.)
- **CP-002**: `with-ca -- node -e fetch(registry.npmjs.org)` → `200`; 78 certificados exportados; daemon bajo `with-ca` → `/health` `env: extraCa=true`.
- **RNF-06**: evento → WS p95 < 10 ms. **RNF-05**: ver proxy arriba.

## Corrida real (sólo lectura sobre `~/.claude/projects`)

Daemon en `127.0.0.1:47893`, `CONTEXTPILOT_HOME` temporal, ~8 s, detenido al final (verificado: puerto cerrado).

- `/health`: `claude-code` **ok**, formatVersion `2.1.284`; `claude-plan-usage` **ok** (muestra de hace ~8 min); `codex` y `gemini-cli` `no-data` (sin `~/.codex/sessions` ni `~/.gemini/telemetry.log`); `hooks`, `web`, `desktop`, `proxy` `no-data`; `env` `extraCa=false`.
- De 315 transcripts sólo se reprocesaron los modificados en los últimos 30 min; `/sessions?active=true` → **3 sesiones activas** de Claude Code: opus-5-5 1M al 27 % (cache 100 %), opus-5 1M al 79 % (56 turnos, cache 100 %), opus-5-5 200k al 51 % (cache 99 %). Statusline: `ctx 27% · cache 100%`, `ctx 79% · cache 100%`, `ctx 51% · cache 99%`.
- `/stats.planUsage` = `{fiveHourPct: 0.33, sevenDayPct: 0.36}`. Sin sugerencias visibles: las que R1 habría disparado ocurrieron hace > 10 min (el replay sólo publica sugerencias todavía vigentes; ver brechas).
- Log sin errores; `cp.db` 708 KB.

## Decisiones y desvíos (para `DECISIONS.md`, a criterio del lead)

- **Contrato**: WS usa `session` (API.md) y no `session-state` (backlog). Cualquier `chrome-extension://*` es aceptado (API.md), no un id configurado (CP-022.4).
- `hook.mjs` usa timeout 1 s (pedido del lead) en lugar de 300 ms (CP-032.3); con daemon caído sale en ~60 ms igual.
- `statusline.mjs` imprime `ContextPilot: sin datos` ante falla (CP-045.3) en vez de línea vacía.
- `/ingest/events` responde 202 (CP-024.1); hooks conocidos 200, desconocidos 202.
- `/health` agrega entradas `env` (CP-002.3: `extraCa`), `config` (si config.json es inválido), `hooks`, `claude-plan-usage`.
- R10 con plan-usage de Desktop trabaja en unidades de % (budget 100): el detalle dice «Usaste 80 de 100». Reemplaza para `anthropic` el plan configurado por el usuario mientras la muestra esté fresca (dato exacto del proveedor > plan estimado); `GET /config` no cambia.
- Tras un reinicio, las sugerencias ya vencidas no se re-publican: una sesión al 79 % no muestra R1 hasta el próximo escalón de 10 puntos. Evita ruido, pero la UI arranca «limpia».
- Traspaso vía `claude -p`: corre en `%LOCALAPPDATA%\ContextPilot\handoff`; su transcript se ignora y `hook.mjs` no reenvía cuando `CONTEXTPILOT_HANDOFF=1`.

## Brechas / pendientes

- **CP-034.3** `scripts/install-gemini-telemetry.mjs` no está (INSTALL.md documenta el bloque a mano). OTLP de Gemini sin verificar contra un CLI real (no instalado).
- **CP-033.5 / CP-034.5** MANUAL: Codex y Gemini CLI no están instalados.
- **CP-035.6 / CP-052.5 / CP-045.5** MANUAL: `ANTHROPIC_BASE_URL=… claude -p "hola"` real, traspaso real con `claude -p` y statusline en una sesión real no se corrieron (el lead decide sobre `settings.json`).
- **CP-056.2**: el dry-run devuelve la Config resultante, no un diff.
- **CP-055**: se valida la forma de `PlanProfile` del core; no hay presets ni el formato `windows: [{hours, limit}]` del backlog.
- **CP-057.1** `scripts/team-export.mjs --week` no está (existe `GET /team/export?from&to`).
- **CP-051.3** CSV y **CP-003** harness de replay: fuera de alcance del daemon.
- El proxy no infiere `cacheTtlMs` (el `ExtractResult` del core no lo trae): R2 de proxy usa el TTL default de 5 min.
- CP-028 medido 60 s, no 10 min. La tabla `offsets` no se purga (una fila por transcript, crece lento).
- Efecto colateral de las pruebas: `with-ca` creó `%LOCALAPPDATA%\ContextPilot\ca.pem` (su ubicación prevista); ningún otro archivo real modificado.
