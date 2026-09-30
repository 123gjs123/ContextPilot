# Backlog — ContextPilot

Fuente: [SPEC.md](SPEC.md) · decisiones: [DECISIONS.md](DECISIONS.md) · trazas: [TRACEABILITY.md](TRACEABILITY.md).
Alcance de este build: fases 0–3 completas. Fecha: 2026-09-30.

## Convenciones

- **ID** `CP-NNN`, estable; no se renumera. Estado inicial de todas: `todo` (`todo` → `doing` → `done` / `partial` / `blocked`).
- **MoSCoW** M/S/C/W. **Fase** 0–3 según SPEC §10.
- **Verificación**: `AUTO` = test vitest (o script `scripts/verify/*`) ejecutable en esta máquina Windows sin sesión real; `MANUAL` = requiere sesión real de navegador, app desktop, interacción visual o aprobación humana; `MIXTA` = parte AUTO, parte MANUAL (cada criterio marcado).
- Criterios en Dado / Cuando / Entonces. Un criterio sin marca es `AUTO`.
- Layout: `packages/core` (tipos, reglas, estado, estimadores, parsers puros) · `apps/daemon` (HTTP+WS, tailers, proxy, sql.js, traspaso) · `apps/extension` (MV3) · `apps/desktop` (Electron: tray, overlay, dashboard, CDP) · `scripts/` (statusline, instalador de hooks, with-ca, verify).
- Fixtures en `fixtures/` (raíz): `claude-code/`, `codex/`, `gemini-cli/`, `web/`, `proxy/`. Todo parser se prueba contra fixtures (RNF-10).
- `D «tema»` remite a la fila de [DECISIONS.md](DECISIONS.md) del 2026-09-30 sobre ese tema (granularidad, ventanas, subagentes, sesión de proxy, portapapeles, ahorro, modo equipo).
- Umbrales numéricos de los criterios son los defaults del SPEC §5 salvo que se indique.

## Orden de construcción (dependencias)

E0 → E1 (CP-004..CP-013) → E2 → E3 → E13(CLI) → E9 → E10 → E7 → E11 → E13(web) → fase 1 (E6, CP-014..CP-018, E12, CP-054, spike CP-043) → fase 2 → fase 3.

## Resumen por épica

| Épica | Módulo | Historias |
| --- | --- | --- |
| E0 | Fundaciones y guardas transversales | CP-001 – CP-003, CP-058 |
| E1 | Core: normalización, estado, reglas | CP-004 – CP-021 |
| E2 | Daemon: API HTTP + WS + almacenamiento | CP-022 – CP-029 |
| E3 | Adaptador Claude Code | CP-030 – CP-032 |
| E4 | Adaptador Codex CLI | CP-033 |
| E5 | Adaptador Gemini CLI | CP-034 |
| E6 | Proxy base-URL | CP-035 – CP-036 |
| E7 | Extensión: captura (claude.ai, chatgpt.com, gemini.google.com) | CP-037 – CP-041 |
| E8 | Desktop (CDP) | CP-042 – CP-044 |
| E9 | UI: statusline | CP-045 |
| E10 | UI: tray / overlay / notificaciones | CP-046 – CP-047 |
| E11 | UI: extensión (banner, side panel, badge) | CP-048 – CP-049 |
| E12 | UI: dashboard | CP-050 – CP-051 |
| E13 | Traspaso | CP-052 – CP-053 (+ CP-041 web) |
| E14 | Configuración | CP-054 – CP-056 |
| E15 | Modo equipo | CP-057 |

---

## E0 — Fundaciones y guardas transversales

### CP-001 · Monorepo, build y tests
Traza: RNF-10, D-2026-09-30 (sin nativos) · Fase 0 · M · todo · AUTO
1. Dado un clon limpio, cuando corro `npm ci` y luego `npm test` en la raíz, entonces vitest corre los tests de todos los workspaces (`packages/*`, `apps/*`) y sale con código 0.
2. Dado el repo instalado, cuando corro `npm run build`, entonces TypeScript compila todos los workspaces sin errores (`strict: true`).
3. Dado `node_modules`, cuando corro `node scripts/verify/no-native.mjs`, entonces no encuentra ningún archivo `*.node` ni `binding.gyp` en dependencias de producción de `packages/*` ni `apps/daemon` y sale con 0 (Electron queda exceptuado sólo en `apps/desktop`).

### CP-002 · Salida por proxy corporativo (`with-ca`)
Traza: RNF-11 · Fase 0 · M · todo · AUTO
1. Dado Windows con CAs corporativas en el almacén del sistema, cuando corro `node scripts/with-ca.mjs -- node -e "fetch('https://registry.npmjs.org').then(r=>console.log(r.status))"`, entonces imprime `200`.
2. Dado el script, cuando exporta el almacén, entonces escribe un PEM en `%LOCALAPPDATA%\ContextPilot\ca.pem`, fija `NODE_EXTRA_CA_CERTS` sólo para el proceso hijo y no instala ninguna CA en el sistema.
3. Dado el daemon arrancado vía `with-ca`, cuando `GET /health`, entonces `env.extraCa=true`.

### CP-003 · Corpus de fixtures y harness de replay
Traza: RNF-10, RF-NOR-01 · Fase 0 · M · todo · AUTO
1. Dado `~/.claude/projects`, cuando corro `node scripts/verify/snapshot-fixtures.mjs`, entonces copia ≥ 3 transcripts reales (uno con subagentes, uno con `ephemeral_1h_input_tokens > 0`, uno con tool_result `is_error: true` si existe) a `fixtures/claude-code/` con todo texto de contenido reemplazado por placeholders de igual longitud y secretos redactados (CP-006), preservando `usage`, `message.id`, timestamps y estructura.
2. Dado el harness `replay(fixtureDir, {speed})`, cuando reproduce un fixture en un directorio temporal a velocidad ×100, entonces los tailers lo consumen como si fuera escritura en vivo (append por líneas, incluyendo una línea partida en dos escrituras).
3. Dado cada formato (Claude Code, Codex, Gemini CLI OTel, SSE claude.ai, SSE chatgpt.com, DOM gemini), entonces existe ≥ 1 fixture con archivo `*.expected.json` de los `TurnEvent` esperados.

### CP-058 · Guarda de cumplimiento: cero pedidos modificados ni envíos automatizados
Traza: RNF-12, criterio fase 0 «cero pedidos modificados» · Fase 0 · M · todo · AUTO
1. Dado el suite `compliance`, cuando corre, entonces verifica que (a) el proxy entrega respuesta byte a byte idéntica al upstream simulado (CP-035), (b) el wrapper de `fetch` de la extensión devuelve al llamador un `Response` cuyo body es idéntico al original (CP-038), (c) el cuerpo del pedido saliente no se altera en ninguno de los dos.
2. Dado el código de `apps/extension`, cuando corre `scripts/verify/no-autosend.mjs`, entonces no hay llamadas a `.click()`, `requestSubmit`, `submit()` ni `dispatchEvent` de `keydown` Enter sobre elementos del sitio (lista blanca explícita sólo para elementos propios del banner).

---

## E1 — Core: normalización, estado y reglas (`packages/core`)

### CP-004 · Contratos canónicos y validador
Traza: RF-NOR-01, RF-SUG-02 · Fase 0 · M · todo · AUTO
1. Dado `TurnEvent` y `Suggestion` exactamente como SPEC §8 (más los campos de D-2026-09-30 «granularidad»), cuando valido un objeto sin `sessionId` o con `tokens.estimated` ausente, entonces el validador lo rechaza con el nombre del campo.
2. Dada una `Suggestion` con `actions: []`, cuando se valida, entonces se rechaza (toda sugerencia tiene ≥ 1 acción de un clic).
3. Dado cualquier parser de adaptador, cuando emite eventos, entonces todos pasan el validador (test genérico sobre todos los `*.expected.json`).

### CP-005 · Estimador de tokens local y marca exacto/estimado
Traza: RF-NOR-02, RF-NOR-03, criterio fase 0 «estimación web ±15 %» · Fase 0 · M · todo · AUTO
1. Dado un origen sin `usage`, cuando normalizo, entonces `tokens.estimated=true` y los conteos provienen del estimador local (sin red).
2. Dado un origen con `usage`, cuando normalizo, entonces `tokens.estimated=false` y los conteos son exactamente los informados.
3. Dado el set de calibración derivado de `fixtures/claude-code/` (mensajes assistant de sólo texto/tool_use, `output_tokens − thinking_tokens ≥ 200`), cuando estimo el texto, entonces la mediana del error absoluto relativo es ≤ 15 % y el p90 ≤ 25 %.
4. Dado un texto de 100 k caracteres, cuando estimo, entonces tarda < 50 ms.

### CP-006 · Privacidad: hashes y redacción de secretos
Traza: RNF-01, RNF-02 · Fase 0 · M · todo · AUTO
1. Dado un prompt, cuando se normaliza, entonces `promptHash` = SHA-256 del texto normalizado (trim, espacios colapsados) y el texto no se incluye en el `TurnEvent` salvo opt-in de contenido de esa fuente (CP-054).
2. Dado texto con `sk-ant-…`, `sk-…`, `AIza…`, `ghp_…`, JWT, `Bearer …`, `password=…` y claves PEM, cuando paso por `redact()`, entonces cada uno queda como `[REDACTED:<tipo>]` y el resto intacto.
3. Dada la base sql.js tras procesar todos los fixtures con opt-in apagado, cuando busco cualquier cadena de ≥ 20 caracteres de contenido de los fixtures, entonces no aparece (test de fuga).

### CP-007 · Estado de sesión
Traza: RF-EST-01 · Fase 0 · M · todo · AUTO
1. Dado una secuencia de `TurnEvent` de una sesión, cuando se aplica, entonces el estado expone `contextSize`, `contextWindow`, `contextPct`, `cacheRatio` (= cacheRead / (input + cacheRead + cacheWrite) de la última llamada), `idleMs` desde el último evento, y acumulados `input/output/cacheRead/cacheWrite/reasoning`.
2. Dado un modelo con sufijo `[1m]` o ventana declarada en config, cuando se calcula `contextWindow`, entonces usa ese valor; dado un modelo desconocido, usa el default (D «ventanas») y marca `windowSource='default'`.
3. Dado eventos de subagente (`isSidechain` / `subagents/*.jsonl`), cuando se aplican, entonces suman a acumulados pero no alteran `contextSize` de la sesión principal.
4. Dado un reinicio del daemon, cuando se rehidrata desde sql.js, entonces el estado es igual al previo (comparación profunda).

### CP-008 · Motor de reglas y umbrales configurables
Traza: RF-REG-01, RF-REG-02, riesgo «reglas exactas no se disparan con estimación» · Fase 0 · M · todo · AUTO
1. Dada una regla que declara `sources` y `requiresExact`, cuando llega un evento de una fuente no declarada, entonces la regla no se evalúa.
2. Dada una regla con `requiresExact=true`, cuando el evento tiene `tokens.estimated=true`, entonces no dispara aunque se cumpla el umbral.
3. Dado un umbral configurado por regla y proveedor (p. ej. R1 `anthropic: 0.55`), cuando se evalúa, entonces usa ese valor por sobre el default; dado un proveedor sin override, usa el default.
4. Dado un evento, cuando se evalúan las 17 reglas habilitadas, entonces la evaluación completa tarda < 20 ms (p99 sobre 1000 eventos del replay).
5. Dada una regla deshabilitada en config, entonces nunca emite.

### CP-009 · Cooldown, agrupación y una sugerencia visible
Traza: RF-REG-03, RNF-13 · Fase 0 · M · todo · AUTO
1. Dado que R1 emitió en la sesión S, cuando vuelve a cumplirse dentro del cooldown (default 20 min, configurable), entonces no emite de nuevo.
2. Dadas dos reglas que disparan en el mismo evento, cuando se publica, entonces sale una sola `Suggestion` visible (mayor severidad; empate → mayor ahorro estimado) y las demás quedan agrupadas en `detail`/`grouped`.
3. Dada una sugerencia vigente en S, cuando otra regla de menor severidad dispara, entonces se encola y no reemplaza la visible; si es de mayor severidad, la reemplaza.
4. Dado feedback `snoozed`, entonces la regla queda silenciada 15 min para esa sesión.

### CP-010 · Reglas R1 (contexto) y R5 (resultado de herramienta grande)
Traza: R1, R5, CU-01 · Fase 0 · M · todo · AUTO
1. Dada sesión Claude Code con `contextPct` 0,61, cuando llega el evento, entonces R1 emite `warn` con acción `copy` payload `/compact <foco>`; para Codex payload `/compact`; para Gemini CLI `/compress`.
2. Dado `contextPct` 0,59, entonces R1 no emite.
3. Dado R1, el `<foco>` se arma con los nombres de archivos/herramientas más usados de los últimos 5 turnos (sin contenido de prompt).
4. Dado un `toolCall` con `resultTokens` 10 001 en fuente CLI, cuando llega, entonces R5 emite `info` con acción `show-detail` que muestra un ejemplo `grep`/`head`/subagente según el nombre de la herramienta; con 10 000 no emite.

### CP-011 · Regla R2 (pausa mayor al TTL de caché)
Traza: R2, CU-02 · Fase 0 · M · todo · AUTO
1. Dada sesión con `contextSize` 150 k, última llamada con `ephemeral_5m_input_tokens > 0` y sin `1h`, cuando pasan 5 min + 1 s sin eventos, entonces un temporizador emite R2 (`warn`) con acciones `handoff` y `copy` (`/clear`).
2. Dado TTL 1 h (última escritura con `ephemeral_1h_input_tokens > 0`), cuando pasan 40 min, entonces no emite; a 60 min + 1 s, emite.
3. Dado `contextSize` 49 k, entonces no emite.
4. Dado hook `UserPromptSubmit` con `idleSincePrevMs` > TTL y contexto > 50 k sin R2 previo en esa pausa, entonces emite al recibir el hook.
5. Dado evento estimado (web), entonces no emite (exige exacto).

### CP-012 · Regla R8 (agente en loop)
Traza: R8, CU-05 · Fase 0 · M · todo · AUTO
1. Dados 3 `toolCalls` consecutivos con mismo `name`+`argsHash` y `failed=true`, entonces R8 emite `critical` con acción `show-detail` (comando, 3 timestamps).
2. Dado un éxito intermedio o args distintos, entonces el contador se reinicia.
3. Dado R8 emitido, entonces la sugerencia llega al canal de notificaciones (CP-047).

### CP-013 · Reglas W1 (conversación web larga) y W3 (regeneraciones)
Traza: W1, W3, CU-04 · Fase 0 · M · todo · AUTO
1. Dada conversación web con ≈ 80 001 tokens estimados o 41 turnos de usuario, entonces W1 emite `warn` con acción `handoff` (traspaso a chat nuevo); con 80 000 y 40 turnos, no.
2. Dada fuente `desktop`, W1 también aplica.
3. Dados 3 eventos `regenerated=true` sobre el mismo turno, entonces W3 emite `info` con `show-detail` (consejos de reformulación); con 2, no.

### CP-014 · Feedback ajusta prioridad
Traza: RF-REG-04 · Fase 1 · S · todo · AUTO
1. Dados 3 `dismissed` consecutivos de la regla X (en cualquier sesión), entonces la severidad efectiva de X baja un nivel y su cooldown se duplica.
2. Dado luego un `accepted` de X, entonces la severidad vuelve al default y el contador se reinicia.
3. Dada severidad `info` y 3 descartes más, entonces X queda en modo «sólo side panel/dashboard» (no banner ni overlay); nunca se deshabilita sola.

### CP-015 · Reglas R3 (caída de caché) y R6 (herramientas/MCP sin uso)
Traza: R3, R6 · Fase 1 · S · todo · AUTO
1. Dados 2 turnos consecutivos con `cacheRead/input` < 0,5 tras un turno ≥ 0,5, entonces R3 emite con `show-detail` listando el diff de modelo, set de herramientas y hash del system prompt entre el turno bueno y los malos.
2. Dado 1 solo turno bajo, no emite.
3. Dada una herramienta/servidor MCP presente en las definiciones y sin invocación en 20 turnos, entonces R6 emite listando cada una con costo por turno (tokens de su definición); con 19, no. Si la fuente no expone definiciones, R6 no se evalúa (health lo indica).

### CP-016 · Reglas R7 y W4 (tarea trivial en modelo/modo caro)
Traza: R7, W4 · Fase 1 · S · todo · AUTO
1. Dado turno en modelo marcado `tier: top` (config) con prompt < 200 tokens y respuesta < 500, entonces R7 emite con acción `copy` `/model <modelo sugerido>` del proveedor.
2. Dado prompt 200 tokens, no emite.
3. Dado turno web en modo caro (thinking/extended/Pro detectado por el adaptador) con prompt < 200 tokens, entonces W4 emite `info` sin acción de copia (acción `show-detail`).

### CP-017 · Reglas R9 y W2 (contenido repetido por hash)
Traza: R9, W2 · Fase 1 · S · todo · AUTO
1. Dado un bloque > 2 k tokens cuyo hash aparece 2 veces en la misma sesión, entonces R9 emite sugerencia de referenciarlo como archivo (acción `show-detail`).
2. Dado un adjunto web cuyo `hash` aparece 2 veces (misma o distinta conversación del mismo sitio en 7 días), entonces W2 emite sugiriendo Projects/Gems/GPTs según sitio.
3. Sólo se persisten hashes, nunca el bloque (verificado por test de fuga CP-006).

### CP-018 · Ritmo de consumo y regla R10 (proyección de límite)
Traza: RF-EST-02, R10, CU-06, criterio fase 1 «proyección < 20 % error en 5 h» · Fase 1 · S · todo · AUTO
1. Dado un perfil de plan con ventana de 5 h y límite L, cuando hay consumo, entonces el estado expone ritmo (tokens/min, media móvil 15 min) y hora proyectada de agotamiento.
2. Dada proyección de agotamiento antes del fin de ventana, entonces R10 emite `critical` con la hora (hh:mm local) y acción `show-detail`.
3. Dado el replay de 5 h de fixtures con agotamiento real conocido en T, cuando se proyecta a 1 h, 2 h y 3 h del inicio, entonces el error |proyectado − T| / duración de ventana es < 20 % en cada punto.
4. Dado perfil API USD, entonces la proyección se expresa en USD usando la tabla de precios de config.

### CP-019 · Embeddings locales y regla R4 (tarea nueva)
Traza: RF-REG-05, R4, CU-03, criterio fase 2 «precisión > 80 % sobre 100 casos» · Fase 2 · S · todo · AUTO
1. Dado el embedder default (hashing n-gram TF, sin descarga), cuando embebo un prompt redactado, entonces devuelve vector de dimensión fija en < 20 ms y se guarda sólo el vector (tabla `embeddings`).
2. Dado `fixtures/r4/cases.json` (100 casos etiquetados: prompt, centroide de sesión, `nuevaTarea` bool), cuando evalúo R4 con coseno < 0,3, entonces precisión > 80 %.
3. Dado R4 disparado, la sugerencia trae acciones `handoff` y `open-session`.
4. Dado `transformers.js` habilitado en config y disponible, entonces se usa en lugar del default con la misma interfaz; si falla la carga, vuelve al default y health lo informa.

### CP-020 · Reglas G1 (tramo de precio Gemini) y G2 (contexto absoluto)
Traza: G1, G2 · Fase 2 · S · todo · AUTO
1. Dado modelo Gemini con tramo configurado (p. ej. 200 k) y evento exacto con `promptTokenCount` 200 001, entonces G1 emite con acción `copy` `/compress`; con estimado no emite.
2. Dado contexto Gemini > 200 k (exacto o estimado), entonces G2 emite `/compress`.

### CP-021 · Cálculo de ahorro estimado
Traza: RF-DSH-02, RNF-14, métricas §11 · Fase 1 · S · todo · AUTO
1. Dada una `Suggestion`, entonces trae `estimatedSavingTokens` calculado por la fórmula de su regla (D «ahorro»), con test unitario por regla.
2. Dado feedback `accepted`, entonces el ahorro se registra como realizado; `dismissed`/`snoozed` no suman.
3. Dado el consumo propio del asesor (tokens de traspasos con modelo), entonces se registra aparte y el cociente consumo/ahorro queda disponible para el dashboard.

---

## E2 — Daemon: API HTTP + WS + almacenamiento (`apps/daemon`)

### CP-022 · Servidor local, token y superficie de red
Traza: RNF-03 · Fase 0 · M · todo · AUTO
1. Dado el daemon arrancado, cuando listo sockets (`netstat -ano`), entonces escucha sólo en `127.0.0.1:47800` (puerto configurable).
2. Dado el primer arranque, entonces genera token aleatorio de 32 bytes en `%LOCALAPPDATA%\ContextPilot\token` y lo reutiliza después.
3. Dado cualquier ruta salvo `GET /health` y `/proxy/*`, cuando falta o no coincide `X-CP-Token`, entonces responde 401 sin cuerpo informativo.
4. Dado un pedido con `Origin` que no sea `chrome-extension://<id configurado>` ni ausente, entonces responde 403.

### CP-023 · Almacenamiento sql.js
Traza: RF-EST-01, RF-SUG-03, SPEC §8 tablas · Fase 0 · M · todo · AUTO
1. Dado el arranque, entonces crea/migra las tablas `sessions`, `turns`, `tool_calls`, `suggestions`, `embeddings`, `settings` con número de versión de esquema.
2. Dado escrituras, entonces se vuelca a `%LOCALAPPDATA%\ContextPilot\cp.db` con debounce ≤ 5 s y escritura atómica (archivo temporal + rename); un `kill -9` en medio no deja archivo corrupto (test simulado).
3. Dada retención configurable (default 30 días), entonces turnos más viejos se purgan al arrancar.

### CP-024 · Ingesta y pipeline evento → sugerencia
Traza: RF-REG-01, RNF-06, criterio fase 0 «sugerencia < 1 s» · Fase 0 · M · todo · AUTO
1. Dado `POST /ingest/events` con `TurnEvent[]` válidos, entonces responde 202 y los aplica al estado; eventos inválidos → 400 con índice y campo.
2. Dado `POST /ingest/hooks/:hookName` con el JSON de stdin de Claude Code, entonces se mapea a evento interno (SessionStart, UserPromptSubmit, PreCompact, Stop); hook desconocido → 202 ignorado y contado en health.
3. Dado un append al transcript de replay que cruza el umbral de R1, cuando mido hasta el mensaje en `WS /stream`, entonces p95 < 1 s sobre 50 repeticiones.
4. Dado un `message.id` ya ingerido, entonces es idempotente (no duplica acumulados).

### CP-025 · Consultas de sesiones y línea de statusline
Traza: RF-EST-01, SPEC §8 API · Fase 0 · M · todo · AUTO
1. `GET /sessions?active=true` devuelve sesiones con evento en los últimos 30 min, con fuente, cliente, modelo, `contextPct`, `cacheRatio`, sugerencia visible.
2. `GET /sessions/:id` devuelve estado + timeline de turnos (sin contenido) + sugerencias.
3. `GET /statusline/:sessionId` devuelve texto plano ≤ 80 columnas con formato `ctx 68% · cache 91% · ⚠ /compact`; `≈` delante de cifras estimadas; sesión desconocida → `ContextPilot: sin datos`; responde en < 50 ms.

### CP-026 · Bus WebSocket y feedback
Traza: RF-SUG-01, RF-SUG-03 · Fase 0 · M · todo · AUTO
1. Dado un cliente en `WS /stream?token=…`, entonces recibe `{type:'suggestion'}`, `{type:'suggestion-cleared'}`, `{type:'session-state'}` y `{type:'health'}`; token inválido → cierre 4401.
2. Dados 3 clientes conectados, cuando se emite una sugerencia, entonces los 3 la reciben.
3. `POST /suggestions/:id/feedback` con `accepted|dismissed|snoozed` persiste en `suggestions` (acción, ts, superficie) y emite `suggestion-cleared`; valor inválido → 400; id inexistente → 404.

### CP-027 · Health por adaptador
Traza: RNF-09 · Fase 0 · M · todo · AUTO
1. `GET /health` devuelve por adaptador `{status: 'ok'|'no-data'|'error'|'disabled', lastEventAt, formatVersion, detail}`.
2. Dado directorio de Codex inexistente, entonces `codex.status='no-data'`.
3. Dado un parser que falla en ≥ 3 líneas seguidas o detecta versión de formato desconocida, entonces `status='error'` y las métricas de esa fuente se muestran como «sin datos» en todas las UIs (no cifras parciales).

### CP-028 · Consumo en reposo
Traza: RNF-07 · Fase 0 · M · todo · AUTO
1. Dado el daemon con todos los adaptadores CLI habilitados y sin actividad, cuando corro `node scripts/verify/idle-resources.mjs --minutes 10`, entonces RSS máxima < 100 MB y CPU promedio < 1 % de un núcleo.
2. Dado los tailers, entonces no hacen polling con intervalo < 1 s en reposo.

### CP-029 · Los clientes siguen funcionando sin daemon
Traza: RNF-08 · Fase 0 · M · todo · MIXTA
1. Dado el daemon detenido, cuando el hook forwarder recibe stdin, entonces sale con código 0 en < 500 ms sin escribir a stdout/stderr (Claude Code no se bloquea).
2. Dado el daemon detenido, la statusline imprime `ContextPilot: sin datos` en < 500 ms.
3. Dado el daemon detenido, la extensión no altera la página y encola eventos (máx. 500, FIFO) que reenvía al reconectar (test con mock).
4. MANUAL: con el daemon detenido, claude.ai, chatgpt.com y gemini.google.com funcionan con normalidad durante una conversación de 3 turnos.

---

## E3 — Adaptador Claude Code

### CP-030 · Parser de transcripts JSONL (puro, en core)
Traza: RF-CAP-01, RF-NOR-01, RF-NOR-02, RNF-10, criterio fase 0 «tokens CLI = usage ±0 %» · Fase 0 · M · todo · AUTO
1. Dadas varias líneas assistant con el mismo `message.id` y mismo `usage`, entonces se emite un solo `TurnEvent`.
2. Dado `usage`, entonces `input=input_tokens`, `cacheRead=cache_read_input_tokens`, `cacheWrite=cache_creation_input_tokens`, `output=output_tokens`, `reasoning=output_tokens_details.thinking_tokens` (si existe), `estimated=false`; y el TTL de caché se infiere de `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`.
3. Dado un `tool_result` con `is_error: true`, entonces el `toolCall` correspondiente tiene `failed=true`; `resultTokens` estimado del contenido; `argsHash` = SHA-256 de los args canónicos.
4. Dado cada fixture de `fixtures/claude-code/`, cuando sumo `input+output+cacheRead+cacheWrite` de los eventos, entonces es igual (±0) a la suma de `usage` deduplicada por `message.id` calculada por un script independiente (`scripts/verify/sum-usage.mjs`).
5. Dado un registro con campos desconocidos o `version` nueva, entonces no falla; registra `formatVersion` y, si faltan campos requeridos, marca health `error`.
6. Dado que corro el parser sobre todos los transcripts reales de `~/.claude/projects` (script de verificación), entonces 0 excepciones y criterio 4 se cumple en todos.

### CP-031 · Tailer en vivo y detección de sesiones
Traza: RF-CAP-01, RNF-06 · Fase 0 · M · todo · AUTO
1. Dado el daemon corriendo, cuando aparece un nuevo `*.jsonl` bajo `~/.claude/projects/**`, entonces en < 1 s se crea la sesión (id = nombre de archivo) y se emite `session-state`.
2. Dado append incremental (incluida línea partida), entonces se procesa sólo lo nuevo desde el offset guardado; una línea incompleta espera a su `\n`.
3. Dado reinicio del daemon, entonces reanuda desde el offset persistido sin duplicar eventos.
4. Dado `<sesión>/subagents/*.jsonl`, entonces se asocia a la sesión padre (D «subagentes»).
5. Dado arranque inicial, entonces no re-procesa transcripts no modificados en las últimas 24 h (sólo registra offset al final).

### CP-032 · Hooks: instalador y reenvío
Traza: RF-CAP-02, RNF-03 · Fase 0 · M · todo · AUTO
1. Dado `node scripts/install-hooks.mjs`, entonces agrega a `~/.claude/settings.json` hooks `SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop` que ejecutan `node <repo>/scripts/hook.mjs <hookName>`, preservando hooks existentes, con backup `settings.json.cp-bak`; correrlo dos veces no duplica entradas.
2. Dado `--uninstall`, entonces elimina sólo las entradas propias.
3. Dado `hook.mjs`, cuando recibe stdin JSON, entonces hace `POST /ingest/hooks/<hookName>` con `X-CP-Token` leído del archivo de token, timeout 300 ms, y siempre sale 0 sin salida (no inyecta contexto ni bloquea).
4. Dado el hook `UserPromptSubmit`, entonces el texto del prompt no se persiste (sólo hash/embedding, salvo opt-in).

---

## E4 — Adaptador Codex CLI

### CP-033 · Parser y tailer de sesiones Codex
Traza: RF-CAP-03, RF-NOR-01, RNF-10 · Fase 0 · M · todo · AUTO
1. Dado `fixtures/codex/` (sintético según formato documentado de rollouts JSONL en `~/.codex/sessions/YYYY/MM/DD/`), entonces el parser emite `TurnEvent` con `provider='openai'`, `input=input_tokens`, `cacheRead=cached_input_tokens`, `output=output_tokens`, `reasoning=reasoning_output_tokens`, `estimated=false`, igual a `*.expected.json`.
2. Dado el tailer apuntando a `CODEX_HOME` o `~/.codex/sessions`, entonces detecta archivos nuevos y appends con el mismo comportamiento que CP-031 (criterios 1–3).
3. Dado el directorio inexistente (esta máquina), entonces health `no-data`, sin errores en log.
4. Dado un rollout con `function_call_output` fallido repetido, entonces `toolCalls.failed=true` alimenta R8.
5. MANUAL: con Codex instalado, una sesión real produce eventos cuyo total coincide con `/status` de Codex.

---

## E5 — Adaptador Gemini CLI

### CP-034 · Lector de telemetría OTel de Gemini CLI
Traza: RF-CAP-04, RF-NOR-01, RNF-10 · Fase 0 · M · todo · AUTO
1. Dado `fixtures/gemini-cli/telemetry.log` (sintético, formato de `telemetry.outfile`), entonces el lector emite un `TurnEvent` por `gemini_cli.api_response` con `input=input_token_count`, `cacheRead=cached_content_token_count`, `output=output_token_count`, `reasoning=thoughts_token_count`, `estimated=false`, y `toolCalls` desde `gemini_cli.tool_call` (`success=false` → `failed`).
2. Dado el daemon, entonces acepta OTLP/HTTP JSON en `POST /otlp/v1/logs` (sin token, sólo loopback) y produce los mismos eventos que el archivo.
3. Dado `node scripts/install-gemini-telemetry.mjs`, entonces escribe en `~/.gemini/settings.json` el bloque `telemetry` (target local, outfile u `otlpEndpoint` HTTP) con backup e idempotencia.
4. Dado archivo inexistente, entonces health `no-data`.
5. MANUAL: con Gemini CLI instalado, una sesión real produce eventos.

---

## E6 — Proxy base-URL (`apps/daemon`)

### CP-035 · Proxy transparente Anthropic / OpenAI / Google
Traza: RF-CAP-08, RNF-04, RNF-05, RNF-11, RNF-12, criterio fase 1 «proxy < 5 ms» · Fase 1 · M · todo · AUTO
1. Dado `ANY /proxy/anthropic/*` (ídem `openai`, `google`), entonces reenvía método, path, query, headers (salvo hop-by-hop) y body al upstream configurado, y devuelve status, headers y body sin modificar, en streaming.
2. Dado upstream simulado local que emite SSE en 50 chunks con 20 ms de separación, entonces el cliente recibe cada chunk con retraso adicional p95 < 5 ms y el primer byte con overhead p95 < 5 ms (`scripts/verify/proxy-latency.mjs`); la respuesta es byte a byte idéntica.
3. Dado pedidos con `x-api-key`, `Authorization` o `x-goog-api-key`, entonces esos valores no aparecen en logs, en sql.js ni en ningún archivo bajo `%LOCALAPPDATA%\ContextPilot` (test de fuga).
4. Dado `HTTPS_PROXY` definido, entonces la salida usa ese proxy con las CAs de `NODE_EXTRA_CA_CERTS`; sin él, sale directo.
5. Dado el daemon caído, entonces el proxy no está disponible: documentar en README que el usuario debe quitar la base URL (limitación conocida de RNF-08 para este canal).
6. MANUAL: `ANTHROPIC_BASE_URL=http://127.0.0.1:47800/proxy/anthropic claude -p "hola"` responde normalmente.

### CP-036 · Extracción de uso desde el stream del proxy
Traza: RF-CAP-08, RF-NOR-01 · Fase 1 · M · todo · AUTO
1. Dados fixtures SSE/JSON de Messages API (`message_start`/`message_delta.usage`), OpenAI Chat Completions (`stream_options.include_usage`) y Responses (`response.completed`), y Gemini `generateContent`/`streamGenerateContent` (`usageMetadata`), entonces se emite un `TurnEvent` exacto por respuesta igual a `*.expected.json`.
2. La extracción corre sobre una copia (tee) del stream; si el parser lanza, la respuesta al cliente no se afecta y health marca `error`.
3. Dado un header opcional `X-CP-Session`, entonces se usa como `sessionId`; si falta, se deriva según D «sesión de proxy».

---

## E7 — Extensión MV3: captura (`apps/extension`)

### CP-037 · Esqueleto MV3, emparejamiento y envío al daemon
Traza: RNF-03, RNF-08, RF-SUG-01 · Fase 0 · M · todo · MIXTA
1. Dado `npm run build -w apps/extension`, entonces genera `dist/` con `manifest.json` MV3 válido con permisos mínimos: `storage`, `sidePanel`, `clipboardWrite` y host permissions sólo para los 3 sitios y `http://127.0.0.1:47800/*`.
2. Dado el token pegado en la página de opciones, entonces el service worker lo guarda en `chrome.storage.local`, abre `WS /stream` y envía lotes a `POST /ingest/events` con `X-CP-Token`.
3. Dado daemon caído, entonces encola (CP-029.3) y reintenta con backoff hasta 30 s.
4. MANUAL: cargar `dist/` sin empaquetar en Chrome y Edge; opciones muestra «conectado».

### CP-038 · Captura SSE de claude.ai y chatgpt.com
Traza: RF-CAP-05, RF-NOR-02, RF-NOR-03, RNF-12 · Fase 0 · M · todo · MIXTA
1. Dado un script en el mundo `MAIN` que envuelve `window.fetch`, cuando la página pide el endpoint de completions del sitio, entonces se clona la respuesta (`tee`), la página recibe el stream original sin cambios y la copia se parsea.
2. Dados fixtures SSE grabados de claude.ai y chatgpt.com (`fixtures/web/`), entonces el parser emite `TurnEvent` con `source='web'`, `client`, `sessionId` = id de conversación de la URL, modelo, tokens estimados (`estimated=true`), `contextSize` acumulado de la conversación, `regenerated` cuando corresponde.
3. Dado un pedido a cualquier otra URL, entonces el wrapper es transparente (mismo objeto de respuesta).
4. MANUAL: en una sesión real de cada sitio, 3 turnos generan 3 eventos visibles en `GET /sessions/:id` y la conversación funciona igual.

### CP-039 · Captura DOM de gemini.google.com
Traza: RF-CAP-06 · Fase 0 · M · todo · MIXTA
1. Dado un fixture HTML de gemini.google.com y mutaciones simuladas en jsdom, entonces el `MutationObserver` emite un turno cuando la respuesta termina de renderizar (sin mutaciones 1,5 s y sin indicador de generación).
2. Selectores aislados en un módulo `selectors/gemini.ts` con versión; si no encuentra el contenedor en 10 s, health `error`.
3. MANUAL: 3 turnos reales generan 3 eventos.

### CP-040 · Capa DOM de respaldo para los tres sitios
Traza: RF-CAP-07, W2, W3 · Fase 0 · S · todo · MIXTA
1. Dado que el wrapper de red no produce eventos en 2 turnos consecutivos en claude.ai o chatgpt.com, entonces la capa DOM toma el relevo y health lo indica (`fallback: dom`).
2. Dado un clic en el control de regenerar detectado por DOM, entonces el evento sale con `regenerated=true`.
3. Dado un adjunto subido, entonces se calcula SHA-256 del archivo en el content script y sólo el hash y tokens estimados viajan en `attachments`.
4. MANUAL: forzando la desactivación del wrapper, los 3 sitios siguen reportando turnos.

### CP-041 · Traspaso web: abrir chat nuevo y pegar sin enviar
Traza: RF-HAN-02, RNF-12, CU-04 · Fase 0 · M · todo · MIXTA
1. Dada la acción `handoff` en el banner, entonces se pide `POST /handoff` con el contenido leído en ese momento del DOM de la conversación (no persistido) y se abre la URL de chat nuevo del sitio.
2. Dado el chat nuevo cargado (fixture jsdom), entonces el texto se inserta en el cuadro de composición mediante eventos de input compatibles con el editor del sitio, y ningún evento de envío es disparado (CP-058).
3. MANUAL: en los 3 sitios, el traspaso queda pegado, editable y sin enviar.

---

## E8 — Desktop (CDP)

### CP-042 · Spike desktop (informe)
Traza: RF-CAP-09, RF-CAP-10, criterio fase 1 «informe de spike» · Fase 1 · S · todo · MANUAL
1. Dado Claude Desktop y ChatGPT Desktop instalados, entonces `docs/spikes/desktop.md` documenta: versión, stack (Electron / nativo), estado de fuses (`EnableNodeCliInspectArguments`, remote debugging), si `--remote-debugging-port` expone targets, endpoints de red observables, y recomendación (CDP / UI Automation / descartar) por app.
2. Si alguna vía requiere MITM o cambios de IT, se escala al humano (no se implementa).

### CP-043 · Adaptador Claude Desktop vía CDP
Traza: RF-CAP-09, criterio fase 2 «desktop health verde 5 días» · Fase 2 · S · todo · MIXTA
1. Dado un servidor CDP simulado (fixture de mensajes `Network.*` con el mismo SSE de claude.ai), entonces el adaptador en `apps/desktop` reutiliza el parser de CP-038 y emite eventos con `source='desktop'`, `client='claude-desktop'`.
2. Dado el puerto CDP no disponible, entonces health `no-data` y reintenta cada 60 s sin consumo notable (CP-028).
3. El adaptador sólo lee (`Network.enable`, lectura de cuerpos); no invoca `Runtime.evaluate` que modifique la página ni `Input.*`.
4. MANUAL: health verde 5 días consecutivos con uso real (registro diario en `docs/spikes/desktop-health.md`).

### CP-044 · Adaptador ChatGPT Desktop
Traza: RF-CAP-10 · Fase 2 · C · todo · MANUAL
1. Dado el informe CP-042 con vía viable, entonces se implementa con la misma interfaz de adaptador; si no hay vía sin MITM, la historia se cierra como `won't` con referencia al informe.

---

## E9 — UI: statusline

### CP-045 · Script de statusline para Claude Code
Traza: RF-EST-01, SPEC §9 statusline, RNF-08 · Fase 0 · M · todo · AUTO
1. Dado stdin JSON de Claude Code con `session_id`, entonces `scripts/statusline.mjs` imprime una línea como `ctx 68% · cache 91% · ⚠ /compact` usando `GET /statusline/:sessionId`.
2. Dado sugerencia vigente, entonces muestra `⚠ <acción corta>`; sin sugerencia, sólo métricas; cifras estimadas con `≈`.
3. Dado daemon caído o > 300 ms, entonces imprime `ContextPilot: sin datos` y sale 0.
4. Dado `node scripts/install-hooks.mjs --statusline`, entonces configura `statusLine` en `~/.claude/settings.json` (con backup; si ya existe una statusline ajena, no la pisa sin `--force`).
5. MANUAL: la línea aparece y se actualiza en una sesión real.

---

## E10 — UI: tray, overlay y notificaciones (`apps/desktop`)

### CP-046 · Tray y overlay con acciones
Traza: RF-SUG-01, RF-SUG-02, RF-SUG-03, RF-HAN-03, SPEC §9 tray · Fase 0 · M · todo · MIXTA
1. Dado el view-model del tray (lógica pura, testeable sin Electron), cuando llegan `session-state` y `suggestion` por WS, entonces produce la lista de sesiones activas y la sugerencia vigente por sesión (máx. una, CP-009).
2. Dada acción `copy`, entonces copia el payload al portapapeles (Electron `clipboard`) y envía feedback `accepted`; «Ignorar» → `dismissed`; «Posponer 15 min» → `snoozed`.
3. Dada acción `handoff` en sesión CLI, entonces copia `<traspaso>` y el comando de limpieza del cliente (`/clear` Claude Code y Gemini CLI, `/new` Codex) según D «portapapeles».
4. Dado un adaptador en `error`/`no-data`, entonces su sesión muestra «sin datos».
5. MANUAL: ícono visible en la bandeja de Windows 11; clic abre overlay; las tres acciones funcionan.

### CP-047 · Notificaciones de Windows para `critical`
Traza: R8, R10, SPEC §9 notificación · Fase 0 · M · todo · MIXTA
1. Dada una sugerencia `critical`, entonces el view-model decide notificar; `warn`/`info` nunca notifican (test).
2. Dada la misma sugerencia recibida dos veces, entonces se notifica una sola vez.
3. MANUAL: la notificación aparece en Windows y el clic abre el overlay en esa sugerencia.

---

## E11 — UI: extensión (banner, side panel, badge)

### CP-048 · Banner sobre el cuadro de texto
Traza: RF-SUG-02, RNF-13, W1, W3, SPEC §9 banner · Fase 0 · M · todo · MIXTA
1. Dada una sugerencia para la conversación actual, entonces se renderiza un banner de una línea con ≤ 2 botones (acción principal + «Ignorar») en un Shadow DOM propio, posicionado encima del compositor sin superponerse (test jsdom: bounding boxes no se intersecan con el compositor del fixture).
2. El banner nunca envía el mensaje ni modifica el texto del compositor salvo la acción de traspaso en el chat nuevo (CP-041).
3. «Ignorar» envía `dismissed` y oculta; no reaparece la misma regla hasta que termine el cooldown.
4. MANUAL: se ve correcto en los 3 sitios en tema claro y oscuro.

### CP-049 · Side panel y badge
Traza: RF-EST-01, RF-CFG-02, SPEC §9 side panel y badge · Fase 0 · M · todo · MIXTA
1. Dado el estado de la conversación activa, entonces el badge muestra `%` de ocupación con color verde < 50 %, amarillo 50–75 %, rojo > 75 % (test de función de color en 49,9 / 50 / 75 / 75,1).
2. Dado el side panel, entonces muestra medidor con `≈`, turnos, historial de sugerencias de la conversación, ahorro acumulado y toggles de reglas del sitio (persisten vía API de config).
3. Dado adaptador del sitio en `error`, entonces badge `?` gris y panel «sin datos».
4. MANUAL: clic en el ícono abre el side panel en Chrome y Edge.

---

## E12 — UI: dashboard (`apps/desktop`)

### CP-050 · Timeline por sesión y salud
Traza: RF-DSH-01, RNF-09 · Fase 1 · S · todo · MIXTA
1. Dado `GET /sessions/:id`, entonces la vista de timeline grafica por turno `contextPct`, `cacheRatio` y marca sugerencias con su feedback (componente testeado con datos de fixture).
2. Dado `GET /health`, entonces el panel de salud lista adaptadores con estado y `lastEventAt`.
3. Filtros por proveedor, fuente y rango de fechas.
4. MANUAL: se abre desde el tray.

### CP-051 · Ahorro por regla y proveedor, métricas y CSV
Traza: RF-DSH-02, RNF-13, RNF-14, CU-07, métricas §11 · Fase 1 · S · todo · MIXTA
1. Dado sugerencias con feedback, entonces muestra ahorro realizado por regla y proveedor, tasa de aceptación por regla, sugerencias por hora activa, proporción de caché CLI y reglas más disparadas (endpoint `GET /stats?from&to`, test sobre datos sembrados).
2. Dado consumo propio del asesor, entonces muestra el cociente consumo/ahorro y lo marca en rojo si ≥ 2 %.
3. «Exportar CSV» produce un archivo con una fila por sugerencia (sin contenido; columnas documentadas).
4. MANUAL: revisión visual con datos de 1 semana.

---

## E13 — Traspaso

### CP-052 · Servicio de traspaso `POST /handoff`
Traza: RF-HAN-01, RNF-01, RNF-02, RNF-14 · Fase 0 · M · todo · MIXTA
1. Dado `POST /handoff {sessionId}` de sesión CLI, entonces el daemon lee el transcript en ese momento, redacta secretos, y genera un resumen ≤ 1 500 tokens con secciones fijas (objetivo, estado, decisiones, archivos, próximos pasos).
2. Dado `claude` disponible en PATH, entonces usa `claude -p --model haiku` (timeout 60 s) y registra sus tokens como consumo propio; si falla o no existe, usa el resumen extractivo local (sin modelo) y lo indica en la respuesta (`method: 'extractive'`).
3. Dado `POST /handoff {sessionId, content}` desde la extensión, entonces usa ese contenido sin persistirlo (test de fuga CP-006).
4. El resumen extractivo es determinista (mismo input → mismo output) y tarda < 2 s sobre el fixture más grande.
5. MANUAL: un traspaso real con `claude -p` es útil para retomar la tarea (juicio del usuario).

### CP-053 · Traspaso CLI al portapapeles sin UI Electron
Traza: RF-HAN-03 · Fase 0 · M · todo · AUTO
1. Dado `node scripts/handoff.mjs <sessionId|--latest> --copy`, entonces coloca en el portapapeles el traspaso seguido de instrucción del comando de limpieza del cliente, vía `powershell -NoProfile -Command Set-Clipboard` con UTF-8 preservado (test: lectura con `Get-Clipboard` devuelve texto con tildes y `≈` intactos).
2. Dado `--print`, entonces imprime a stdout sin tocar el portapapeles.

---

## E14 — Configuración

### CP-054 · Configuración base: adaptadores, reglas, umbrales, opt-in
Traza: RF-CFG-02, RF-REG-02, RNF-01 · Fase 0 · M · todo · AUTO
1. Dado `%LOCALAPPDATA%\ContextPilot\config.json` (esquema validado, defaults del SPEC), entonces `GET /config` lo devuelve y `PUT /config` lo valida y aplica en caliente sin reiniciar.
2. Dado un adaptador deshabilitado, entonces su tailer/listener se detiene y health `disabled`; dada una regla deshabilitada, no evalúa.
3. Dado `contentOptIn: {<fuente>: true}`, sólo entonces esa fuente puede persistir contenido (redactado); default todo `false`.
4. Config inválida en disco → se usa la última válida y health lo informa.

### CP-055 · Perfiles de plan por proveedor
Traza: RF-CFG-01, RF-EST-02 · Fase 1 · M · todo · AUTO
1. Dado un perfil `{provider, kind: 'api', pricing}` o `{provider, kind: 'subscription', windows: [{hours: 5, limit}, {days: 7, limit}]}`, entonces se valida y lo usa CP-018.
2. Presets editables para planes conocidos, con límites marcados «a calibrar» (el proveedor no publica cifras exactas).
3. Sin perfil, R10 no se evalúa y el side panel/tray no muestra proyección.

### CP-056 · Exportar / importar configuración
Traza: RF-CFG-03 · Fase 2 · C · todo · AUTO
1. `GET /config/export` devuelve JSON con versión de esquema, sin token local ni API keys.
2. `POST /config/import` valida, muestra diff (respuesta `dryRun=true`) y aplica con `dryRun=false`; versión de esquema anterior se migra.

---

## E15 — Modo equipo

### CP-057 · Exportación agregada y anonimizada + vista agregada
Traza: RF-TEAM-01, RNF-01, criterio fase 3 · Fase 3 · C · todo · MIXTA
1. Dado `node scripts/team-export.mjs --week`, entonces genera un JSON con sólo agregados (por proveedor/regla/semana: sesiones, tokens, sugerencias, aceptación, ahorro); sin `sessionId`, sin hashes, sin nombres de proyecto/rutas, sin modelo de embedding.
2. Test de fuga: el archivo no contiene ninguna cadena hex ≥ 16 caracteres, ningún ULID/UUID, ninguna ruta, ninguna cadena de los fixtures; buckets con < 5 sesiones se suprimen.
3. Dado N archivos exportados, el dashboard los importa y muestra el agregado del equipo (sin servidor; D «modo equipo»).
4. MANUAL: aprobación de seguridad registrada en `docs/DECISIONS.md` antes de marcar `done`.
