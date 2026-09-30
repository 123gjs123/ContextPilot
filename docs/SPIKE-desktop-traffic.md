# Spike desktop 2 — Tráfico y datos locales de Claude Desktop

Fecha: 2026-09-30 · Máquina: Windows 11 Pro 10.0.26200 (usuario sin admin) · App: Claude Desktop 2.16120.0 (MSIX, Electron 44.4.3) · Continúa [SPIKE-desktop.md](SPIKE-desktop.md).

Pregunta: «¿podemos analizar el tráfico saliente de Claude Desktop y, a partir de eso, identificar qué envía y qué recibe?». Objetivo: conseguir por conversación y en modo sólo lectura datos de turno (tiempos, tamaño de prompt y respuesta y, si se puede, modelo y uso de tokens) para `TurnEvent` con `source: 'desktop'`.

Reglas del spike: nada de certificados, admin, cambios en la app, reinicios de la app del usuario ni pedidos a Anthropic. No se leyeron cookies ni tokens. Todo el contenido se inspeccionó sólo por forma (nombres de campos, largos y timestamps); en este documento no hay texto de mensajes.

## Resumen

| # | Vía | Qué da | Near-real-time | Veredicto |
| --- | --- | --- | --- | --- |
| 1a | **IndexedDB `claude-conversation-store`** (perfil Chromium de la app) | **Chat:** árbol completo de la conversación (mensajes, `created_at`, timestamps de inicio y fin por bloque, `stop_reason`, tools y adjuntos, modelo de la conversación). **Cowork/Code:** eventos del Agent SDK con **`usage` exacto**, `modelUsage` por modelo, `duration_ms`, `ttft_ms` y `stop_reason` | Sí (el writer escribe con *debounce* de segundos; se midieron **~16 s** después del fin del turno en Cowork). En chat hay que validarlo en vivo | **Recomendada.** Viable en JS puro y sólo lectura |
| 1b | Caché HTTP de Chromium (`Cache/Cache_Data`, formato *blockfile*) | Respuestas JSON de `GET …/chat_conversations/{id}?tree=True…` (zstd): el mismo árbol que 1a | **No** (se escribe sólo al abrir o refrescar una conversación; la última es del 2026-09-17) | Sirve sólo como backfill o catálogo de endpoints |
| 1c | Logs (`main.log`, `claude.ai-web.log`), Local Storage, Session Storage | Nada por turno (memoria, plugins, OAuth *refresh*, warnings de React Query) | — | Descartado |
| 1d | `plan-usage-history.json` | % de las ventanas de 5 h y 7 días | ~15 min | Ya implementado (`apps/daemon/src/adapters/planUsage.ts`) |
| 2 | Metadatos de red sin descifrar | IP y puerto remotos y hora de apertura de cada conexión; contadores de E/S del proceso (mezclan disco y red) | Sí, pero grueso | Sólo sirve como señal de «hay actividad». No distingue conversaciones ni turnos |
| 3 | Descifrado (SSLKEYLOG, net-log, proxy) | Red completa | — | **Bloqueado por la app** y además necesita captura (Npcap/admin) + IT (RNF-11) |
| 4 | UI Automation | Árbol de accesibilidad | — | **No viable** en esta build sin efectos colaterales: el contenido web no se expone (14 elementos, 0 `Document`). Esto corrige la recomendación del spike 1 |

**Recomendación:** implementar un adaptador `desktop` que lea en modo sólo lectura la IndexedDB `claude-conversation-store` de la app (log LevelDB + blobs, en JS puro). Da datos **exactos** para Cowork/Code y datos de tiempo exactos con tokens **estimados** para el chat. No hace falta interceptar tráfico.

---

## 1. Almacenamiento local

### Ubicaciones

| Ruta | Contenido |
| --- | --- |
| `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\` | Perfil Chromium/Electron virtualizado por MSIX. Aquí están todos los datos relevantes |
| `%LOCALAPPDATA%\Claude\logs\` | Logs activos (`main.log` 6,1 MB, `claude.ai-web.log`, `mcp.log`, …). La copia bajo `LocalCache\Roaming\Claude\logs` está congelada desde el 2026-08-21 |
| `%APPDATA%\Claude`, `%LOCALAPPDATA%\AnthropicClaude` | No existen |

Inventario del perfil (tamaño total por carpeta, 2026-09-30 11:16 local):

| Carpeta / archivo | Archivos | Bytes | Última escritura | Nota |
| --- | --- | --- | --- | --- |
| `IndexedDB\https_claude.ai_0.indexeddb.leveldb` + `.blob` | 18 | 6,9 M | hoy 10:47 | **Fuente principal** (ver 1a) |
| `Cache\Cache_Data` | 2 226 | 372 M | hoy 11:15 | Caché HTTP *blockfile* (`index`, `data_0..3`, `f_xxxxxx`) |
| `Local Storage\leveldb` | 10 | 12,8 M | hoy 11:15 | En la escritura activa sólo aparecen `intercom-state` y `META` |
| `Session Storage` | 8 | 150 K | hoy 10:43 | Navegación, borradores y `predecessorDocument` |
| `WebStorage\N\IndexedDB` | 100 | 680 K | 09-29 | IndexedDB de particiones (artifacts) |
| `Partitions\*` | 112 | 7,2 M | hoy | `launch-preview-static`, `cowork-file-preview`, artifacts |
| `local-agent-mode-sessions` | 247 | 4,2 M | hoy 11:14 | Plugins y skills de Cowork (`rpm/manifest.json`, `SKILL.md`). **No** contiene transcripts |
| `Network\` | 7 | 100 K | hoy | `Cookies` (**material de autenticación**, cifrado con la clave `os_crypt` de `Local State`), `TransportSecurity`, `Network Persistent State`. No se leyó |
| `config.json` | 1 | 14 K | hoy | Tiene las claves `oauth:tokenCache` y `oauth:tokenCacheV2` (**material de autenticación**; se listaron sólo los nombres de clave, no los valores) |
| `plan-usage-history.json` | 1 | 58 K | hoy 11:19 | Ya se usa |
| `vm_bundles`, `claude-code-vm`, `claude-code` | — | 9,9 G / 243 M / 246 M | — | Imagen de la VM de Cowork y binarios de Claude Code |
| `logs`, `sentry`, `Crashpad`, `Code Cache`, `GPUCache`, … | — | — | — | Sin datos de turnos |

### 1a. IndexedDB `claude-conversation-store` — la fuente buena

**Qué es.** El frontend de claude.ai (el mismo bundle que carga la app) persiste en IndexedDB su caché de conversaciones. La búsqueda estática en el bundle cacheado `shared-common-*.js` muestra `var ec="claude-conversation-store",tc="trees",nc="meta",rc="2.2"`, productos `["chat","hub","cowork","code"]`, un writer en segundo plano (`tag:"conversation_store_writer"`) y constantes de *debounce* `2e3`, `1e4` y `4e3` ms. La clave es `<uuid>` para chat y `<product>:<id>` para el resto (por ejemplo `cowork:cse_…`).

**Formato físico.**
- Carpeta `IndexedDB\https_claude.ai_0.indexeddb.leveldb\`: LevelDB normal. `NNNNNN.log` es el *write-ahead log* **append-only** (bloques de 32 KiB, registros `FULL/FIRST/MIDDLE/LAST`, *WriteBatch* con `seq`, `count` y `put(key,value)`). Las tablas `.ldb` usan bloques Snappy.
- Valor: `varint` (versión IDB) + sobre Blink `FF 15 FE <trailer>` + **serialización V8** `FF 10 …` (versión de formato V8 **16**).
- Los valores grandes van a `IndexedDB\https_claude.ai_0.indexeddb.blob\<db>\<xx>\<n>` con el encabezado `FF 11 02` + **Snappy** + la misma serialización V8. Se vieron archivos de 71 KB a 1,3 MB, mientras que un árbol de 49 KB quedó *inline* en el log. Cada blob es autodescriptivo: incluye `conversationUuid`, `product` y `writtenAt`.
- Se decodificó en **JS puro** (sin módulos nativos). Hicieron falta un lector del log LevelDB (~40 líneas), un descompresor Snappy (~15 líneas) y `v8.deserialize` de Node. Node 24 trae V8 13.6, que sólo acepta hasta la versión de formato 15; bajar el byte de versión de 16 a 15 alcanzó para decodificar todos los registros `trees` y `meta` (138 valores), pero es un truco frágil (ver Riesgos). Los 2 962 valores que no se decodificaron son de otras object stores (índices, `keyval-store` con otro sobre) y no hacen falta.
- Leer los archivos mientras la app los tiene abiertos funciona (Chromium los abre con *share read*).

**Registros `meta`** (uno por conversación, se reescribe en cada cambio): `conversationUuid`, `product` (`chat` | `cowork` | …), `accountUuid`, `orgUuid`, `lastOpenedAt`, `writtenAt`, `fetchedAt`, `conversationUpdatedAt`, `approxBytes`, `messageCount`. Sirven como detector de cambios barato.

**Registros `trees` — product `chat`** (misma forma que la respuesta de la API `chat_conversations/{id}?tree=True`):
- Conversación: `uuid`, `name`, `summary`, **`model`** (por ejemplo `claude-fable-5`), `created_at`, `updated_at`, `settings` (incluye `thinking_mode` y `effort_level`), `platform`, `current_leaf_message_uuid`, `chat_messages[]`, además de índices del árbol (`messageByUuid`, `parentByChildUuid`, `selectedChildByUuid`, …).
- Mensaje: `uuid`, `index`, `sender` (`human` | `assistant`), **`created_at`**, `updated_at`, `input_mode`, `truncated`, **`stop_reason`** (`end_turn`, `tool_use_limit`, …), `attachments[]`, `files[]`, `sync_sources`, `parent_message_uuid`, `content[]`.
- Bloque de contenido: `type` (`text` | `thinking` | `tool_use` | `tool_result`), `text` (se midió sólo el largo), **`start_timestamp` / `stop_timestamp`**, y en tools `name`, `input`, `is_error`, `integration_name` y `mcp_server_url`.
- **No hay `usage` ni tokens**, y el modelo es por conversación, no por mensaje. Ejemplo medido: mensaje humano de 83 caracteres a las 07:01:21 → respuesta de 1 010 caracteres, bloque de 5 781 ms, `end_turn`.

**Registros `trees` — product `cowork` / `code`** (`tree.kind`, `events[]`, `headSeq`, `hasOlder`, …). Los eventos son mensajes del Agent SDK (`kind:"message"`, `payload.type` ∈ `user`, `assistant`, `result`, `system/init`, `rate_limit_event`, `autocompact_state`, `permission_resolved`, …) con `serverCreatedAt`:
- `assistant.payload.message`: `model` (por ejemplo `claude-opus-5-5`), **`usage`** (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_{5m,1h}_input_tokens`, `service_tier`), `stop_reason`, `content[]`.
- `result`: **`usage`** agregado del turno, **`modelUsage{<model>: {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, thinkingTokens, contextWindow, maxOutputTokens, costUSD}}`**, `duration_ms`, `duration_api_ms`, **`ttft_ms`**, `num_turns`, `stop_reason`, `is_error`, `subtype`, `total_cost_usd`, `user_message_uuid`, `result_index`. Ejemplo real: `dur 40 780 ms, ttft 3 960 ms, in 4 / out 2 970 / cacheRead 510 115 / cacheWrite 14 840, model claude-fable-5-1, num_turns 2`.
- `rate_limit_event`: `unifiedWindows.five_hour` y `seven_day` con `utilization` y `resetsAt` (el mismo dato que plan-usage, pero en vivo).

**Latencia y frecuencia (evidencia del log actual, 32 registros entre el 24 y el 30/09):**
- Cowork C2: `conversationUpdatedAt 21:24:57` → `trees` escrito a las **21:25:13 (+16 s)**.
- Cowork C3 durante una sesión activa (29/09 10:17–10:22): `meta` reescrito 7 veces con `messageCount` 83→81→85→86→84 y `approxBytes` en aumento; el `tree` quedó en el blob `5/01/17a` a las 10:22:06, con 3 `result` a las 10:19:17, 10:20:26 y 10:22:04. Es decir, persiste **por turno**, unos segundos después de terminar.
- Chat: sólo hay escrituras al abrir conversaciones (C4 y C5 el 29 y 30/09; la última actividad de chat en Desktop fue el 28/09). Durante este spike **el usuario no chateó en Desktop**: en 5 min de muestreo cada 30 s (09:22–09:27 UTC) el `.log` de IndexedDB no cambió de tamaño (1 400 621 B). Por eso la latencia por turno en chat **no se verificó en vivo**. El código del writer es común a todos los productos, así que se espera el mismo comportamiento de segundos. Queda como criterio MANUAL (ver §6).
- Ojo: en Windows, el `LastWriteTime` de un archivo abierto que recibe *appends* se retrasa. `main.log` mostraba 09:57 cuando ya tenía líneas de las 11:17. El adaptador debe detectar cambios por **tamaño**, no por mtime.

**Otras stores de la misma DB:** `react-query-cache` (blob Snappy/V8 con `buster`, `timestamp` y `clientState.queries[]`) guarda listas (`chat_conversation_list`, `project_list`, `sessions_api_list_sessions`, `current_account`, `subscription_details`, …) pero no conversaciones. Sirve a lo sumo para descubrir conversaciones activas.

### 1b. Caché HTTP (`Cache\Cache_Data`)
- Formato *blockfile* de Chromium: `index`, `data_0..3` y `f_xxxxxx` externos. `EntryStore` de 256 B en `data_1` con la key en el offset 96, `data_size[4]` y `data_addr[4]`; stream 0 = headers (pickle) y stream 1 = body **tal como llegó por la red** (`content-encoding: zstd` → `zlib.zstdDecompressSync` de Node 24). Se parseó con ~80 líneas de JS.
- Contiene 47 respuestas `GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=…` (hasta 8,6 MB descomprimidas) con los mismos campos que 1a (conversación con `model`, mensajes con `created_at`, timestamps por bloque y `stop_reason`; **sin usage**).
- **No es near-real-time.** Se escribe cuando la UI pide la conversación entera (abrirla o refrescarla), no por turno. La entrada más nueva es del 2026-09-17. El streaming `POST …/completion` (SSE) no se cachea.
- Es útil para responder «qué pide la app» (catálogo en §2) y para backfill.

### 1c. Logs y storage web
- `main.log`: 12 k líneas `[process-memory]`, además de `[PluginsFetcher]`, `[remote-tools-device]`, `[oauth-v2]`, `[EventLogging] Flushing N events`, `[a11y]`, … Cero coincidencias con `completion`, `chat_conversation`, `input_tokens` o `message_start`.
- `claude.ai-web.log` (consola del renderer): warnings de React Query y CSP, y `[LOCAL_SESSION]` con digests. Nada por turno.
- Local Storage y Session Storage: nada útil.

### Endpoints observados (claves de la caché HTTP, ids enmascarados; responde «qué pide la app»)

| Endpoint (GET salvo indicación) | Entradas |
| --- | --- |
| `claude.ai/api/organizations/{org}/conversations/{id}/wiggle/download-file` | 175 |
| `…/files/{id}/contents`, `/api/{id}/files/{id}/preview` y `thumbnail` | 146 / 137 / 9 |
| `…/artifacts/wiggle_artifact/{id}/manage/storage/info`, `tools` y `versions` | 135 / 43 / 23 |
| `claude.ai/v1/code/sessions/watch`, `…/sessions/{cse_id}/events[/stream]` y `file` | 120 / ~45 / 11 |
| **`…/chat_conversations/{id}?tree=True&rendering_mode=…`** | 47 |
| `…/plugins/list-plugins`, `skills/*` y `marketplaces/*` | 32 / 14 / 6 |
| `…/conversation/search/v2`, `chat_conversations_v2` (lista), `projects[_v2]` | 15 / 7 / 12 |
| `…/chat_conversations/{id}/completion_status` y `composer_notices` | 5 / 2 |
| `…/usage` (uso del plan) | 3 |
| `POST …/chat_conversations/{id}/completion` (SSE; según el código de la app, spike 1) | no cacheable |

---

## 2. Metadatos de red sin descifrar

Procesos: el árbol de Desktop es `12460` (browser), del que cuelgan `23360` (utility `network.mojom.NetworkService`, **toda la red sale de acá**), dos renderers, GPU, audio, video y crashpad. Hay otros `claude.exe` (`26804`, `26668`, `21124`) que son **Claude Code** (extensión de VS Code, `…\native-binary\claude.exe`); hay que filtrarlos por `ExecutablePath` bajo `WindowsApps\Claude_*`.

`Get-NetTCPConnection` (no pide admin) sobre `23360`: 2 conexiones `Established` a `160.79.104.10:443` (desde las 09:14:56, larga duración: HTTP/2 multiplexado) y `18.97.36.65:443`, más 2 sockets `Bound`. El caché DNS (`Get-DnsClientCache`) resuelve `160.79.104.10` a `api.anthropic.com`. Datadog (`34.149.66.165`) aparece desde el Claude Code, no desde Desktop.

Proxy: WinINET `ProxyEnable=0` sin PAC, WinHTTP «acceso directo», sin `HTTPS_PROXY`. **El MITM corporativo es transparente o inline**: las conexiones figuran contra las IPs reales de Anthropic y no contra un host de proxy. La app confía en la CA corporativa a través del almacén de Windows.

Bytes por conexión: `GetPerTcpConnectionEStats` necesita que un admin active la recolección con `SetPerTcpConnectionEStats` (requisito documentado; no se probó porque no hay admin). ETW (`Microsoft-Windows-TCPIP`, kernel network) también requiere admin. Lo que sí está disponible sin admin es `Win32_Process.{Read,Write,Other}TransferCount` y el contador `\Proceso(*)\Bytes de datos ES/s` (el nombre está localizado en español). Suman **disco + red** del proceso: se midió un delta de 1 232 B leídos y escritos en 20 s en reposo. El NetworkService también escribe la caché HTTP, así que la señal viene contaminada.

**Conclusión:** sin descifrar sólo se obtiene la hora de actividad del proceso de red (y de nuevas conexiones). Con HTTP/2 multiplexado no hay forma de separar conversaciones, turnos ni tamaños. No vale como fuente de `TurnEvent`; a lo sumo sirve como «heartbeat».

## 3. Opciones de descifrado (análisis estático, sin probar en la app viva)

En `app\resources\app.asar` (sólo lectura):
- La lista de switches prohibidos incluye `ssl-key-log-file`, `log-net-log`, `net-log-capture-mode`, `host-rules`, `host-resolver-rules`, `ignore-certificate-errors`, `disable-web-security`, `remote-debugging-port/pipe`, `*-cmd-prefix`, `browser-subprocess-path`, … Con cualquiera de ellos la app sale con `process.exit(1)` («refusing to start — a debugging or network-override switch…»), salvo que haya un token `CLAUDE_CDP_AUTH` firmado por Anthropic.
- `T.app.isPackaged && !i3 && (delete process.env.CLAUDE_USER_DATA_DIR, delete process.env.SSLKEYLOGFILE, delete process.env.sslkeylogfile)`: la variable **`SSLKEYLOGFILE` se borra** en el proceso principal antes de que arranquen los procesos hijos (el NetworkService la heredaría). **El key logging no se respeta.**
- La app admite `egressProxyUrl` y `egressProxyPacUrl` desde la configuración *workspace* administrada (política empresarial), que se traducen a `proxy-server` / `proxy-pac-url` y a `HTTPS_PROXY` para los CLI que lanza. Hace falta un cambio de política gestionado por IT, más un reinicio, y un proxy sin MITM sólo vería `CONNECT host`.
- Aunque se pudieran obtener las claves, descifrar requiere capturar paquetes (Npcap, instalación con admin) y cae en RNF-11 / D «Sin MITM en v1» (aprobación de IT). Con el MITM corporativo en el medio, la sesión TLS visible es app↔proxy corporativo; el descifrado «oficial» ya lo tiene IT, y sus logs no son una fuente aceptable (privacidad, otra jurisdicción).

**Veredicto: no viable** en el marco del proyecto. Además es innecesario, porque 1a da más datos que la red para Cowork/Code (el `usage` del SSE de chat sería lo único extra).

## 4. UI Automation

Sonda con `UIAutomationClient` (sin admin, imprimiendo sólo conteos):
- Ventana `Chrome_WidgetWin_1` del pid 12460, visible y no minimizada: **14 descendientes** (11 `Pane` y 3 `Button` de la barra de título), **0 `Document`**, sin `AutomationId`.
- No existe `Chrome_RenderWidgetHostHWND` como hijo; sólo hay `Intermediate D3D Window`.
- Un `AccessibleObjectFromWindow(OBJID_CLIENT)` (MSAA) seguido de otra sonda UIA no cambió nada (14 elementos). `main.log` tiene `[a11y] accessibility support disabled at startup features=none` y la sonda no generó ningún evento `accessibility-support-changed`, así que no hubo efecto colateral.
- Para exponer el contenido haría falta `--force-renderer-accessibility` (implica reiniciar la app, prohibido y además sujeto al chequeo de switches) o activar el flag global de lector de pantalla (`SPI_SETSCREENREADER`) o ejecutar un lector de pantalla. Las dos opciones cambian el sistema del usuario y degradan el rendimiento de todas las apps Chromium.

**Veredicto: no viable** sin efectos colaterales. Esto invalida la recomendación «spike UI Automation» del spike 1.

---

## 5. Ranking

Escala: 1 (mejor) a 5 (peor) en fidelidad, estabilidad y riesgo de política.

| Opción | Fidelidad | Estabilidad | Riesgo de política | Comentario |
| --- | --- | --- | --- | --- |
| **A. IndexedDB `claude-conversation-store`** | Cowork/Code **1** (usage exacto); chat **2** (tiempos exactos, tokens estimados) | **3**: esquema interno del frontend web, que cambia con cada deploy de claude.ai (tiene campo `v:"2.2"` para detectarlo); también dependen del formato V8 y Blink | **1**: lectura local de datos propios, sin red, sin credenciales ni cambios | **Recomendada** |
| B. Caché HTTP | Chat 2 | 3 | 1 | Sólo backfill (no es por turno) |
| C. `plan-usage-history.json` / `rate_limit_event` | Plan, no turno | 2 | 1 | Ya en uso (R10) |
| D. Metadatos TCP / contadores E/S | 5 | 2 | 1 | Sólo heartbeat |
| E. UI Automation | 3 (si funcionara) | 4 | 3 (cambia el estado a11y del sistema) | No funciona sin efectos colaterales |
| F. Descifrado TLS / MITM / proxy | 1 | 4 | **5** | Bloqueado por la app, además de admin + IT |

## 6. Diseño del adaptador recomendado (no implementado)

**Nombre:** `apps/daemon/src/adapters/desktopStore.ts` (health `claude-desktop-store`), con `source:'desktop'`, `client:'claude-desktop'` y `provider:'anthropic'`.

**Rutas** (misma resolución que `planUsagePaths`, sobreescribible con `CONTEXTPILOT_DESKTOP_IDB_DIR`):
- `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\IndexedDB\https_claude.ai_0.indexeddb.leveldb\` → leer **sólo** `*.log`, además de `CURRENT` para saber cuál está activo.
- `…\IndexedDB\https_claude.ai_0.indexeddb.blob\**` → archivos nuevos o modificados.
- **Lista blanca estricta:** el adaptador no abre nada fuera de esas dos carpetas (ni `Network\Cookies`, ni `config.json`, ni `Local State`).

**Estrategia de parseo (JS puro, sin nativos):**
1. `ldbLog.ts`: tail incremental del `.log` activo. Guarda el offset y relee desde el último bloque de 32 KiB completo. Cuando el número de log cambia (compactación), reinicia en el nuevo archivo. Opcionalmente, en el arranque, hace un backfill del `.ldb` (SSTable con bloques Snappy).
2. `snappy.ts` (~20 líneas) para blobs (`FF 11 02` + Snappy) y bloques `.ldb`.
3. `v8Deserialize.ts`: deserializador **propio** del subconjunto V8 necesario (objetos, arrays densos y dispersos, strings de uno y dos bytes, `I`/`N`/`T`/`F`/`_`/`0`, `Date`, referencias `^`), tolerante a la versión 15/16. Reemplaza el truco de bajar la versión para `v8.deserialize`. Hay que saltear el sobre Blink (`FF 15 FE`+12 bytes del trailer, o `FF 11 02` para blobs).
4. Filtro: sólo valores con `conversationUuid` + `product` + (`tree` | `messageCount`). Se valida `v === "2.2"` (o `tree.v`); si la versión es desconocida, health pasa a `error: formato x.y no soportado` y no emite cifras (RNF-09/10).
5. Detección de cambios: `fs.watch` sobre las dos carpetas más un polling de **tamaño** cada 2 s (por el mtime atrasado de Windows). Se usa `meta.messageCount` / `conversationUpdatedAt` como disparador y el `trees` (inline o blob) como dato.
6. Dedup: `chat` → `message.uuid` del asistente; `cowork`/`code` → `result.uuid`. Se persiste el conjunto visto por conversación (SQLite `turns`).

**Latencia esperada:** debounce del writer (2–10 s) + polling (2 s). Observado: ~16 s en Cowork. Alcanza para las reglas por turno (RNF-06 cuenta desde el evento).

**Mapeo a `TurnEvent`:**

| Campo | `chat` (estimado) | `cowork` / `code` (exacto) |
| --- | --- | --- |
| `sessionId` | `tree.uuid` (conversation uuid) | `conversationUuid` (`cse_…`) |
| `turn` | ordinal del par human→assistant en la rama `current_leaf` (`parent_message_uuid`) | `result.result_index` / ordinal de `result` |
| `ts` | `created_at` del assistant (o `stop_timestamp` del último bloque) | `serverCreatedAt` del `result` |
| `model` | `tree.model` (de la conversación; puede diferir si se cambió a mitad de la conversación) | `assistant.message.model`; con varios modelos se toma el de mayor `outputTokens` en `modelUsage` |
| `tokens.input` | tokenizer local sobre el texto de la rama hasta el prompt (texto sólo en memoria) | `usage.input_tokens` |
| `tokens.output` | tokenizer sobre `text` + `thinking` del assistant | `usage.output_tokens` |
| `tokens.cacheRead/cacheWrite` | — | `cache_read_input_tokens` / `cache_creation_input_tokens` |
| `tokens.reasoning` | tokenizer sobre los bloques `thinking` si existen | `modelUsage[m].thinkingTokens` / `output_tokens_details.thinking_tokens` |
| `tokens.estimated` | `true` | `false` |
| `contextSize` | estimación acumulada de la rama | `input + cacheRead + cacheWrite` de la última iteración (`usage.iterations[-1]`) |
| `contextWindow` | tabla por modelo | `modelUsage[m].contextWindow` |
| `idleSincePrevMs` | `human.created_at` − `stop_timestamp` del assistant anterior | `turn_started_wall_ms`/`serverCreatedAt` del `user` − `result` anterior |
| `toolCalls` | bloques `tool_use`/`tool_result`: `name`, `is_error`, `argsHash = sha256(input)`, `resultTokens` estimado | lo mismo, desde `assistant.message.content` y los eventos `user` con `tool_result` |
| `promptHash` | sha256 del texto humano normalizado (el texto no se persiste, RNF-01) | igual, desde el evento `user` |
| `attachments` | `attachments[]` / `files[]` → hash del nombre + tamaño → tokens estimados | igual |
| `regenerated` | hay más de un hijo assistant para el mismo `parent_message_uuid` | — |
| extras | TTFT ≈ `content[0].start_timestamp` − `human.created_at`; duración = `stop` − `start` | `duration_ms`, `ttft_ms` y `rate_limit_event.unifiedWindows` (alimenta R10 en vivo) |

**Privacidad y cumplimiento:** el adaptador tiene el texto en memoria sólo mientras calcula largos, tokens y hashes. No persiste ni loguea contenido, uuids de org ni de cuenta. Es sólo lectura, sólo la sesión propia (RNF-12) y sin red. Si el usuario borra conversaciones, aparecen `tombstone:true` en `meta` → se purga en SQLite.

**Tests (RNF-10):** fixtures sintéticas generadas con `v8.serialize` + un writer LevelDB de prueba y blob Snappy, con placeholders. Casos: versión desconocida → health `error`; compactación y rotación de log; registro partido en `FIRST/MIDDLE/LAST`; blob.

**Pendiente MANUAL antes de implementar:**
1. Con la app abierta en una conversación de **chat**, mandar 1 mensaje y verificar que en ≤ 15 s crece el `.log` o aparece un blob nuevo, con `meta.messageCount` +2 y el nuevo par en `trees`.
2. Lo mismo con la conversación **no enfocada** (otra pestaña o ventana minimizada), para saber si el writer persiste sin UI activa.
3. Repetir después de una actualización de la app o de claude.ai para ver cambios de `v`.

**Riesgos:**
- Esquema no documentado del frontend web: puede cambiar sin aviso. Mitigación: chequear la versión y degradar a health `error`.
- Formato V8 16 frente al V8 de Node: por eso el deserializador propio.
- Conversaciones sin abrir en la app, o eviction del store, pueden quedar sin datos. El `writer` persiste lo que está en la caché de React Query; para el caso de uso, que es la conversación activa, alcanza.
- Tokens de chat estimados (±10–15 % según el tokenizer).

## Reproducción (sólo lectura)
- Los parsers exploratorios quedaron fuera del repo (scratchpad de la sesión): `ldblib.js` (log LevelDB + Snappy + V8), `blockcache.js` (blockfile de la caché HTTP + zstd), `keys.js` y `rq.js`. Todos imprimen formas y largos, nunca contenido.
- Red: `Get-CimInstance Win32_Process -Filter "Name='claude.exe'"` (filtrar por `ExecutablePath` en `WindowsApps`) → `Get-NetTCPConnection -OwningProcess <NetworkService>`; `Get-DnsClientCache`.
- UIA: `Add-Type -AssemblyName UIAutomationClient` → `FindAll(Descendants, TrueCondition)` sobre la ventana del pid del browser.
