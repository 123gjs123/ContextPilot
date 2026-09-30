# Fixes 2: defectos de la aceptación ronda 2 (D-19…D-23, D-5, D-14, D-16)

Fecha: 2026-09-30 · Base: `7374d11` (sin commit) · Windows 11, Node 24.15.0.
Fuentes: [ACCEPTANCE.md §7](../ACCEPTANCE.md#7-ronda-2--commit-7f00517), [DECISIONS.md](../DECISIONS.md) (filas nuevas al final), [API.md](../API.md) «Extensiones de tipos (ronda 2)».
El daemon real (`127.0.0.1:47800`, `%LOCALAPPDATA%\ContextPilot`) **no se tocó**: las pruebas de integración usan daemons propios en un puerto libre con home y carpeta de proyectos temporales. No se leyó almacenamiento de Claude Desktop, salvo `plan-usage-history.json` (sólo lectura, fuente aprobada en H-7) para `eval-projection.ts`.

## Corridas finales

| Comando | Resultado |
| --- | --- |
| `npx vitest run` | **54 archivos, 466 pass, 1 skipped**, exit 0 (incluye los 31 de `scripts/test/**`, D-20; 29 tests nuevos en `core/fixes2.test.ts` y `daemon/fixes2.test.ts`). En la primera corrida completa falló el test de overhead del proxy por carga de la máquina (umbral 25 ms). Solo pasó (primer byte p95 3,3 ms) y en la re-corrida completa también: es la inestabilidad ya registrada en DECISIONS («overhead del proxy») |
| `npm run typecheck` | exit 0 (core src+test, daemon, desktop, extension) |
| `npm run build` | exit 0: typecheck + `dist/ listo (5 bundles, manifest MV3 validado)` + `[desktop] build ok` |
| `npx tsx scripts/verify/r10-replay-cooldown.ts` | **exit 0** (antes exit 1): control y «evento de hace 20 min en replay» → R10 tras el arranque y tras el evento en vivo |
| `npx tsx scripts/replay-transcripts.ts --top 5` | 10 296 eventos, **0,43 sugerencias/h activa** (R2 0,12 · R1 0,10 · R5 0,09 · R3 0,06 · R6 0,04 · R4 0,03), igual que en la ronda 2 |
| `npx tsx scripts/verify-estimator.ts` | antes: 329 muestras, agregado **2,7 %**, p10 −6,4 %, mediana −0,2 %, p90 13,1 %, ±15 % **89 %** → después: agregado **2,3 %**, p10 −7,4 %, mediana −0,9 %, p90 12,8 %, ±15 % **89 %** |
| `npx tsx scripts/verify/estimator-abs.ts` | antes: 409 muestras, mediana \|err\| 4,9 %, p90 17,3 %, 87 % ≤ 15 % → después: 5,2 %, 17,1 %, 88 % |
| `npx tsx scripts/verify/real-transcripts-usage.ts` | 321 archivos (217 subagentes), 14 602 llamadas, 0 excepciones, diferencia **0** (D-16 no descarta ninguna llamada real) |
| `node scripts/snapshot-fixtures.mjs` (dry-run) | 40 sesiones, 3 elegidas, OK. Capa 2: `etiquetas=0` en las 3 (antes 735/937/231, que eran re-conteos) |
| `npx tsx apps/daemon/scripts/eval-projection.ts` | ver D-5 |

## Defecto → cambio → test

| # | Cambio | Tests |
| --- | --- | --- |
| **D-19** (alta) | `RuleEngine.evaluate({ dryRun })`: calcula sin fijar cooldowns, lugar visible ni `byId`. `Pipeline.ingest(..., { replay: true })` evalúa en seco y **no publica nada** (sólo reconstruye estado). `engine.restore()`: al construir el pipeline, las sugerencias abiertas en `cp.db` recuperan su lugar visible y el cooldown desde su creación (no se duplican tras reiniciar) | `core/fixes2` «D-19» (R10 y R1 en seco: nada fijado; el evento en vivo publica). `daemon/fixes2` «D-19»: pipeline con reloj simulado (replay de hace 20 min → 0 publicadas; primer evento en vivo → R10 `account:anthropic`, una fila); replay aún «vigente» no deja cooldown de R1; daemon aislado con transcript de hace 20 min + plan-usage caliente → R10 en `/account` y `⏳ límite` en la statusline; el evento en vivo no la duplica. `verify/r10-replay-cooldown.ts` exit 0 |
| **D-20** (alta) | `vitest.config.ts` raíz incluye `scripts/test/**/*.test.ts`. `scripts/verify/vitest.scripts.config.ts` eliminado (redundante; TRACEABILITY actualizado). `scripts/lib/snapshot.ts` `hardenTags()`: `<xxxx>` es el placeholder que ya puso el core y no se cuenta como corrección de la capa 2. La aserción `tags: 0` queda como estaba | `scripts/test/snapshot-fixtures.test.ts:119` verde; 31/31 de `scripts/test` dentro de `npm test` |
| **D-21** (media) | `effectiveTokens()` (= `input + cacheWrite + output + 0,1·cacheRead`) y `rawTokens()` en `projection.ts`. Muestras de sesión con `raw`. `Burn.rawTokensPerMin`. `storage.usagePoints()` → `{ts, tokens: efectivos, raw}`, así que la **serie local de R10** y `/stats.burn` usan efectivos. `ProviderBurn.rawTokensPerMin`. API.md actualizado | `core/fixes2` «D-21» (fórmula con los números del lead; burn de sesión incl. sidechain; muestras viejas sin `raw`); `daemon/fixes1` «D-5» ajustado (efectivos 13 180/llamada, `rawTokensPerMin` 130 000, `projections[0].used` en efectivos) |
| **D-22** (media) | `RuleEngine.evaluateAccount({provider, now, usageWindow})`: reglas `scope:'account'` sin evento de sesión. El daemon lo llama cada 60 s (`accountEvalMs`), cuando `PlanUsageAdapter` detecta muestras nuevas (`onSamples`) y al terminar el escaneo inicial. TTL de la sugerencia de cuenta = cooldown (60 min). Si la condición sigue, se **renueva** (mismo id, `expiresAt` nuevo, `storage.refreshSuggestion`, re-difusión si cambia título o severidad o pasó media vida). También se renueva desde `evaluate()` con eventos de sesión, en lugar de quedar `suppressed: cooldown`. Cuando la proyección deja de cumplirse, se retira (`suggestion-cleared` `expired`); re-armado ≤ 15 min | `core/fixes2` «D-22» (publica sin evento; TTL 60 min; renovación a los 40 min con el mismo id; visible a los 90 min; retiro; re-armado; renovación vía evento de sesión; descarte → cooldown desde la última renovación; `restore`; sin plan no evalúa; TTL de sesión sigue en 10 min). `daemon/fixes2` «D-22» (60 min de ticks de 60 s: una sola fila y un solo id, visible todo el tiempo, retiro al enfriarse la serie; reinicio del pipeline sin duplicar; daemon aislado **sin ninguna sesión** → R10 por WS/hello, y retiro al escribir un plan-usage plano) |
| **D-5** (parcial) | Proyección **amortiguada**: `exhaustAt` con `ritmo × rateDamping` (R10 `thresholds.rateDamping`, default 0,6). `Projection.projectedPerHour` (aditivo); `perHour` sigue siendo el medido. `/stats|/account.burn` usan la ventana y la amortiguación de R10. El detalle de R10 muestra los dos ritmos. `evaluateProjection` agrega el método `damp:<f>:<min>` y `windowFilter`. `eval-projection.ts` imprime error, agotamientos detectados y falsas alarmas para todas las ventanas, el ajuste (1ª mitad) y la validación (2ª mitad) | `core/fixes2` «D-5»; `core/projection.test.ts` (CP-018.3 literal ahora con la amortiguación de R10: sigue < 20 % a 1/2/3 h) |
| **D-16** (parcial) | Parser de Claude Code: versión con mayor fuera de 1.x–2.x o llamada `assistant` sin `message.id` / `usage.input_tokens` / `usage.output_tokens` numéricos → no emite cifras, `formatErrors`, `formatIssue`. `JsonlAdapter` pasa `claude-code` a `error` en el acto con ese detalle y `formatVersion` (warn en el log una vez por detalle) | `core/fixes2` «D-16» (rangos de versión; usage ausente/no numérico/sin id; `<synthetic>` y JSON inválido sin cambio; fixture real sin errores de formato). `daemon/fixes2` «D-16» (versión 3.0.0 → health `error` + detalle + `formatVersion`, las cifras no se suman; llamada sin `usage` → detalle de campos, sin sesión) |
| **D-23** (baja) | `estimateTokens`: URLs y corridas alfanuméricas ≥ 16 caracteres con letras y dígitos se cobran por longitud (3 caracteres/token, antes del factor del proveedor) | `core/fixes2` «D-23» (hash de 64 hex, URL, listado mixto; aditividad; palabras largas sin dígitos sin cambio) |
| **D-14** (baja) | `Config.modelTiers` (aditivo; id exacto → fragmento más largo → tabla), `modelTier()`/`isTopTier(..., overrides)`; el motor lo pasa en `RuleContext.modelTiers`; R7 lo usa; `mergeConfig` y `validateConfigPatch` | `core/fixes2` «D-14»; `daemon/fixes2` «D-14» (`PUT /config` 400/200; R7 dispara con un modelo declarado `top`) |

## D-5: números antes y después (plan-usage real, 676 muestras, 41 ventanas de 5 h completas)

Error = |% proyectado al final − % real al final| en puntos de la ventana. «Agotamiento» = casos cuya ventana terminó ≥ 99 % y se proyectaron ≥ 100 %. Solo **2 ventanas** reales llegaron a 100 % (6 casos: 3 en cada mitad), así que esa parte de la evidencia es débil.

| Estimador | Conjunto | Media | 1 h | 2 h | 3 h | Agotamiento | Falsas alarmas |
| --- | --- | --- | --- | --- | --- | --- | --- |
| antes: ritmo 60 min (`recent:60`) | todas | 19,6 % | **26,8 %** | 18,3 % | 10,8 % | 6/6 | 15 |
| **después: ritmo 60 min × 0,6** (`damp:0.6:60`) | todas | 14,0 % | **18,8 %** | 13,2 % | 7,8 % | 6/6 | 5 |
| antes | ajuste (1ª mitad, 20 ventanas) | 19,3 % | 24,9 % | 19,2 % | 10,6 % | 3/3 | 6 |
| después | ajuste | 14,7 % | 19,8 % | 13,4 % | 8,7 % | 3/3 | 3 |
| antes | **validación** (2ª mitad, 21 ventanas, no usada para elegir) | 19,9 % | 28,5 % | 17,4 % | 10,9 % | 3/3 | 9 |
| después | **validación** | **13,3 %** | **17,8 %** | 13,1 % | 7,1 % | 3/3 | 2 |

- **Cómo se eligió.** Sobre la mitad de ajuste se buscó el menor error que no pierda ningún agotamiento real del ajuste. Factores 0,2–0,5 dan menos error (1 h ≈ 15–17 % en validación) pero pierden 1 de los 3 agotamientos del ajuste, y con 0,6 se detectan los 3. También se probaron EWMA del ritmo (half-life 15–120 min), ventanas de ritmo de 30–180 min, un decaimiento exponencial del ritmo y una mezcla con el patrón histórico de ventanas anteriores (incremento medio restante, calculado en línea sin mirar el futuro). Sus errores fueron parecidos (ewma 0,5: validación 1 h 15,4 %; mezcla 0,5: 17,6 %), pero con más parámetros o peor en el ajuste. No aportan lo suficiente para justificarlos con 41 ventanas.
- **Honestidad.** A 1 h, el ajuste queda en 19,8 %, justo en el borde. Validación, 17,8 %. Con ritmo constante (fixture sintético) la amortiguación subestima: el error de `exhaustAt` es 12,4 % / 11,7 % / 4,0 %, todavía < 20 %. El uso real es a ráfagas: 39 de 41 ventanas terminan por debajo de 80 %. Por eso amortiguar mejora el error medio y baja las falsas alarmas de 15 a 5. El costo es avisar más tarde cuando el ritmo de verdad se sostiene. Conviene re-medir con más semanas de datos (`eval-projection.ts` ya imprime la partición).

## D-23: detalle de la medición

Muestras de verdad: 71 `tool_result` reales con delta de contexto entre dos llamadas consecutivas (sólo resultados de herramientas en el medio, sin *thinking*, estimación ≥ 3000). Con ≥ 20 % de caracteres en URLs/hashes (13 muestras) la mediana del error pasa de **+24,5 % a +0,6 %**. Sin URLs/hashes (54 muestras) no cambia: **+15,1 %**. El parámetro se eligió de una grilla sobre esas mismas 13 muestras (sin partición: son pocas). El caso del lead (19 439 caracteres, `agent-a9bff8fed22cf7692.jsonl`) pasa de 13 147 a **12 917** tokens estimados (real ≈ 11 195, +15,4 %). Ese texto es sobre todo JS minificado con algunas URLs, y el sesgo que queda es general de los `tool_result`: el factor 1,3 se calibró con prosa. Queda propuesto un factor propio para resultados de herramientas, fuera del alcance de D-23.

## Pendiente / fuera de alcance

- D-16: sigue sin test `chrome.storage`/WS/POST del service worker (CP-037.2), toggles por `PUT /config` desde el panel (CP-049.2) y panel de salud del dashboard (CP-050.2). Codex y Gemini no tienen rango de versiones conocido.
- D-19: un cruce de R1 ocurrido mientras el daemon estaba caído ya no se re-publica desde el replay. Avisa el siguiente escalón de 10 puntos o R2 (DECISIONS D-19).
- D-7 (fixtures reales escritos y commiteados) no estaba en este encargo.
- No se hizo commit.
