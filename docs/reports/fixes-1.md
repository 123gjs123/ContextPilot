# Fixes 1 — defectos D-1…D-18 de ACCEPTANCE §4 (core, daemon, extensión, desktop)

Fecha: 2026-09-30 · Base: `b3b25b0` (sin commit) · Windows 11, Node 24.15.0. Alcance: `packages/core`, `apps/*`, config raíz. `scripts/` lo trabajó otro agente (sólo se corrió su `replay-transcripts.ts`).

## Corridas finales

| Comando | Resultado |
| --- | --- |
| `npx vitest run` | **48 archivos, 406 pass, 1 skipped** (portapapeles real, gated) |
| `npm run typecheck` (raíz) | exit 0: core (src + test), daemon, desktop, extension |
| `npm run build` (raíz) | typecheck + `dist/ listo (5 bundles, manifest MV3 validado)` + `[desktop] build ok` |
| `CP_PERF_STRICT=1 npx vitest run apps/daemon/test/proxy.test.ts` | RNF-05 estricto: primer byte p95 **1,71 ms**, +**0,48 ms** por chunk |
| `npx tsx apps/daemon/scripts/eval-projection.ts` | plan-usage real: 676 muestras, 41 ventanas de 5 h (ver D-5) |
| `npx tsx scripts/replay-transcripts.ts` (versión del agente de scripts) | TOTAL 10 281 eventos, **0,46 sugerencias/h activa** (su definición de hora activa: 292 h); R2 0,12/h, R1 0,10/h, R5 0,09/h, R6 0,06/h, R3 0,06/h, R4 0,02/h |

## Defecto → cambio → test

| # | Cambio | Tests |
| --- | --- | --- |
| **D-1** | `Rule.scope: 'account'`; R10 publica con `sessionId = account:<proveedor>`, cooldown y lugar visible propios, fuera del cupo por sesión (`engine.ts` `select()`). Pipeline/UIs: `GET /account`, statusline `· ⏳ límite hh:mm`, banner «Cuenta …» en overlay (`accountRows`), color del tray, tarjeta «Cuenta» en side panel (`PanelState.account`). H-7 (plan-usage sin perfil) registrado en DECISIONS | `core/fixes1.test.ts` «D-1» (50 sesiones → R1×50, R10×1; otro proveedor, otro lugar); `daemon/fixes1.test.ts` «D-1» (plan-usage caliente real simulado: R1 `warn` por WS en las 50 sesiones, 1 sola R10, `/account`, statusline); `desktop/account-overlay.test.ts`; `ext/panelView.test.ts` «D-1» |
| **D-2** | R1 `warn` desde el umbral. Parser Claude Code registra en memoria archivos (nombre base) y herramientas de los últimos 5 prompts → `focus()`; `JsonlAdapter.focusFor()`; el pipeline decora R1 con `/compact <foco>` al publicar y en lecturas (`decorate`), sin persistir. Sin tema del prompt (CP-010.3) | `core/fixes1` «D-2»; `core/parsers/claudeCodeInventory.test.ts` «foco» (sin texto de prompt, sin rutas, ≤ 180 car.); `daemon/fixes1` «D-2» (transcript real en disco → WS con `/compact Conservá el trabajo sobre archivoSecretoFoco.ts (Edit)…`, `/suggestions` igual, `cp.db` sin el nombre) |
| **D-3** | `shortAction()` en core por regla; `statuslineText` lo usa y agrega aviso de cuenta. `scripts/statusline.mjs` no requirió cambios (imprime la línea del daemon) | `core/fixes1` «D-3»; `daemon/fixes1` «D-3» (R5 → `⚠ grep/head`, R8 → `⚠ loop!`, con cuenta ≤ 80 col.); `daemon/planUsage.test.ts` (formato SPEC intacto) |
| **D-4** | R6 `sources: claude-code, proxy`. Claude Code: inventario MCP estimado por servidor desde `deferred_tools_delta` / `deferred_tools_record` / `mcp_instructions_delta` (`estimated: true`, `≈`); uso por prefijo `mcp__srv__*`. Proxy: `requestInfo().toolsUsed` (último mensaje del asistente) → `toolCalls`. `adapters/mcpConfig.ts` lee sólo nombres de `mcpServers` (sólo lectura) para `/health` `rule-R6`. Cooldown R6 24 h | `core/fixes1` «D-4» (servidor agrupado, `≈`, vía motor con proxy exacto); `core/parsers/claudeCodeInventory.test.ts`; `daemon/proxy-providers.test.ts` (OpenAI: `get_weather` usado, `never_used` no). Sobre el transcript real más grande: 3 servidores (Atlassian ≈19 k, Docs ≈2,2 k, Drive ≈0,3 k) |
| **D-5** | `projection.ts`: `planWindows`, `projectWindow/projectPlan`, `sessionBurn` (15 min), `evaluateProjection` (1/2/3 h). `SessionView.burn`; `/stats.burn` y `/account.burn` por proveedor. R10 usa `projectPlan` con ritmo 60 min (elegido por medición). `apps/daemon/scripts/eval-projection.ts` | `core/projection.test.ts` (fixture sintético `plan-usage/replay-5h.json` con agotamiento conocido: error \|T̂−T\|/5 h < 20 % a 1/2/3 h; burn); `daemon/fixes1` «D-5» |
| **D-6** | R4: acción `handoff` + `open-session` (+ `/clear`). Dataset `packages/core/test/fixtures/r4/cases.json` (100 casos, 25 contextos ES/EN). Umbral: se mantiene 0,30. `transformers.js`: no implementado (DECISIONS) | `core/r4.dataset.test.ts` (regla real: **precisión 87,5 % (35/40), recall 70 %**; monotonía de la curva); `core/fixes1` «D-6» |
| **D-8** | `typecheck` por workspace (core con `tsconfig.test.json` que incluye tests); raíz `typecheck` = workspaces; `build` = typecheck + bundles | corridas de arriba |
| **D-9** | `daemon.allowedExtensionIds` (validado: 32 letras a-p); `originAllowed(origin, ids)` en HTTP y WS; vacío → permisivo + aviso en log y `/health` `origin` | `daemon/fixes1` «D-9» (vacío: aviso y 200; con id: otro id 403, el permitido 200; id inválido 400) |
| **D-10** | Proxy: `EnvHttpProxyAgent` con `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` del entorno del daemon; extractor inyectable (tests); `systemHash` y `toolCalls` en el evento | `daemon/proxy-providers.test.ts`: OpenAI y Google de punta a punta (bytes idénticos, headers/`?key=` reenviados, uso exacto); fuga de `Authorization`, `x-api-key`, `x-goog-api-key` y `?key=` en `cp.db`, **logs** y todo el home, también con upstream caído; proxy corporativo simulado (HTTP absolute-form y `CONNECT` HTTPS); extractor que lanza → bytes idénticos, `proxy: error`, sin evento, el siguiente pedido pasa |
| **D-11** | Pipeline: índice por sitio hash → subidas (7 días) en `settings.attachmentIndex`; `siteAttachmentCounts` al motor; W2 usa el máximo | `core/fixes1` «D-11»; `daemon/fixes1` «D-11» (otra conversación del mismo sitio dispara; otro sitio no; > 7 días no; índice persistido) |
| **D-13** | `ToolCall.ts` (lo completa `applyEvent`); R8 detalle «Comando: Bash (args #abcdef12), fallos a las hh:mm:ss, …» (sin contenido del comando) | `core/fixes1` «D-13» |
| **D-14** | R5 `show-detail` con ejemplo por herramienta (`toolExample`); R3 lista cambio de system prompt (`systemHash`, proxy) y cambio de modelo aunque haya sido 2 turnos antes. `tier` configurable: **no hecho** | `core/fixes1` «D-14» |
| **D-15** | `config.json.last-valid` (carga/guardado válido); inválido → última válida + health; `PlanProfile.windows` (5 h + 7 d) validado y evaluado por R10 | `daemon/fixes1` «D-15»; `core/fixes1` «D-15» (dos ventanas, gana la que se agota primero, series `byWindow`) |
| **D-16** | Tests nuevos donde no hacía falta navegador/Electron | rehidratación profunda tras reinicio (`daemon/fixes1` «D-16»: `toEqual` del estado completo); «Ignorar»/«Posponer 15 min» del overlay en jsdom (`desktop/account-overlay.test.ts`); reintento CDP y `markRefused` (`desktop/cdp-retry.test.ts`). **No**: versión de formato desconocida → error, campos faltantes → error (no implementados), `chrome.*` del SW, toggles del panel por `PUT /config`, panel de salud del dashboard |
| **D-17** | `vitest.config.ts`: `pool: 'forks'` explícito, `teardownTimeout` 15 s. `spawnDaemon`: hijos registrados y muertos en `process.on('exit')`, `stop()` idempotente; test de overhead con `try/finally`. No reproducido | suite completa verde |
| **D-18** | R2: rama `response` sólo sin evento `prompt` previo; pipeline salta R2 en el prompt que cierra una pausa ya avisada por el temporizador (`skipRules`). Desempate contra la vigente por ahorro (si no, R1 `warn` bloqueaba al R2 proactivo) | `core/fixes1` «D-18» y «lugar visible»; `daemon/fixes1` «D-18» (temporizador + prompt 40 min después → 1 sola R2) |

### Pedidos adicionales del lead

| Pedido | Cambio | Tests |
| --- | --- | --- |
| Sanitizador del core (D-7) | `sanitizeTranscriptLine(line, { identity, stats })` con la segunda pasada de `scripts/lib/snapshot.ts`: claves sin forma de identificador → placeholder único de igual longitud; sólo etiquetas de Claude Code; valores de metadato sólo con forma de id/enum y sin identidad; objetos libres (`input`, `toolUseResult`, `snapshot`, `answers`, `structuredContent`) sin excepciones. Nuevos exports puros: `identityTerms(records, systemTerms)`, `addTokens`, `findEmails`, `KNOWN_TAGS`, `FREE_KEYS`. `placeholder(s, opts?)` compatible. Fixture `claude-code/session-*.jsonl` re-sanitizado (tenía rutas del proyecto como claves de `trackedFileBackups`); `*.expected.json` sin cambios | `core/parsers/sanitize.test.ts` (identidad en claves/etiquetas/valores; sólo core sin identidad; el parser ve el mismo uso/herramientas/fallos/modelos) |
| Overhead del proxy flaky | Medición real siempre impresa; aserción por defecto < 25 ms (un bufferizado agregaría ≥ 20 ms); < 5 ms estricto con `CP_PERF_STRICT=1` y el archivo solo. Además `try/finally` para el hijo | `daemon/proxy.test.ts` |

**Para el agente de `scripts/`:** `scripts/lib/snapshot.ts` ya puede delegar en el core (`sanitizeTranscriptLine(l, { identity: identityTerms(records, [hostname(), userInfo().username]) })`). Con el core nuevo fallan 2 expectativas de `scripts/test/snapshot-fixtures.test.ts` que documentaban la debilidad anterior: «el sanitizador del core solo deja pasar identidad» (`coreOnly.ok` ahora es `true`) y el dry-run que espera estadísticas de capa 2 > 0 (ya no queda nada que corregir). No se tocó `scripts/`.

## Números

### D-5 — error de proyección a 5 h (CP-018.3)

`eval-projection.ts` sobre `plan-usage-history.json` real (sólo lectura), error = \|% proyectado al fin de ventana − % real\| / 100:

| Ritmo | Casos | Media | p90 | 1 h | 2 h | 3 h |
| --- | --- | --- | --- | --- | --- | --- |
| últimos 30 min (antes) | 107 | 20,8 % | 47 % | 25,5 % | 22,1 % | 12,2 % |
| **últimos 60 min (R10 ahora)** | 107 | **19,6 %** | 48 % | **26,9 %** | **18,2 %** | **10,8 %** |
| media desde el inicio | 107 | 23,3 % | 52 % | 31,7 % | 22,4 % | 12,3 % |

Fixture sintético (agotamiento conocido): < 20 % en 1/2/3 h (test). **Con datos reales el criterio «< 20 % en cada punto» no se cumple a 1 h**: el uso real es a ráfagas y la extrapolación lineal sobreestima (67/107 casos). No se calibró amortiguación sobre los mismos datos.

### D-6 — R4 (100 casos)

| Umbral coseno | Precisión | Recall |
| --- | --- | --- |
| 0,25 | 94,1 % | 32 % |
| 0,28 | 87,5 % | 56 % |
| **0,30 (default)** | **87,5 %** | **70 %** |
| 0,31 | 88,9 % | 80 % |
| 0,32 | 81,5 % | 88 % |
| 0,34 | 78,0 % | 92 % |

Por dificultad: en los casos «fáciles» la precisión a 0,30 es 100 %; en los difíciles (seguimiento parafraseado vs. otra tarea del mismo dominio) 77 %. Dataset sintético: queda validar con prompts reales.

### D-18 — replay (5 sesiones reales más grandes, «descartar» simulado, hora activa = intervalos ≤ 30 min, 131 h, 419 prompts)

| | R1 | R2 | R3 | R4 | R5 | R6 | Total/h activa |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Antes (`b3b25b0`) | 43 | 67 | 17 | 7 | 19 | 0 | 1,17 |
| Después | 43 | 67 | 17 | 7 | 19 | 13 | **1,27** |

R2 no bajó: en estos transcripts el cooldown de 30 min ya evitaba el doble aviso; son 67 pausas largas distintas (0,51/h). El cambio garantiza una emisión por pausa también fuera del cooldown (test). R6 es nuevo (antes inalcanzable); con cooldown de 120 min daba 27 disparos (hasta 15 en una sesión), con 24 h da 13. SPEC §11 (≤ 3/h) se cumple.

## Pendiente / no hecho

- `tier` de modelo configurable (D-14), versión de formato desconocida / campos faltantes → health `error` (CP-027.3, CP-030.5).
- Tests de `chrome.*` del service worker, toggles del panel persistidos por `PUT /config` y panel de salud del dashboard (requieren mocks de `chrome`/Electron más grandes).
- `transformers.js` (CP-019.4): no implementado por decisión.
- Decisiones humanas abiertas que estos cambios dejan configurables: H-5 (`allowedExtensionIds`), H-7 (plan-usage sin perfil).
