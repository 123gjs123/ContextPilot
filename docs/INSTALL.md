# Instalación y uso del daemon

Windows 11, Node 24. Todo corre local en `127.0.0.1`; no hay servicios externos.

## 1. Instalar

```powershell
cd C:\ruta\a\contextpilot
$env:NODE_OPTIONS = "--use-system-ca"   # sólo si hay proxy TLS corporativo
npm ci
Remove-Item Env:NODE_OPTIONS
npm test                                 # opcional: suite completa (vitest)
```

## 2. Arrancar el daemon

```powershell
npm start -w @contextpilot/daemon            # = tsx apps/daemon/src/main.ts
# detrás de un proxy corporativo (CAs del almacén de Windows → NODE_EXTRA_CA_CERTS):
npm run start:ca -w @contextpilot/daemon     # = node scripts/with-ca.mjs -- node --import tsx src/main.ts
```

Imprime `ContextPilot daemon 0.1.0 en http://127.0.0.1:47800`. Se detiene con Ctrl+C.

| Variable | Default | Uso |
| --- | --- | --- |
| `CONTEXTPILOT_HOME` | `%LOCALAPPDATA%\ContextPilot` | `token`, `config.json`, `cp.db`, `ca.pem`, `logs\daemon.log` |
| `CONTEXTPILOT_PORT` | `47800` | Puerto (siempre en 127.0.0.1) |
| `CLAUDE_CONFIG_DIR` / `CONTEXTPILOT_CLAUDE_PROJECTS` | `~\.claude` / `~\.claude\projects` | Transcripts de Claude Code |
| `CODEX_HOME` / `CONTEXTPILOT_CODEX_SESSIONS` | `~\.codex` / `~\.codex\sessions` | Rollouts de Codex |
| `CONTEXTPILOT_UPSTREAM_ANTHROPIC` / `_OPENAI` / `_GOOGLE` | APIs oficiales | Upstream del proxy (tests) |
| `CONTEXTPILOT_CLAUDE_BIN` | `claude` en PATH o binario de la extensión de VS Code | CLI para el traspaso; `none` lo desactiva |
| `CONTEXTPILOT_PLAN_USAGE_FILE` | `plan-usage-history.json` de Claude Desktop | Uso del plan para R10 |
| `CONTEXTPILOT_LOG_STDERR=1` | — | Log también a stderr |

Estado: `curl http://127.0.0.1:47800/health` (sin token). `env.detail` muestra `extraCa=true` cuando corre bajo `with-ca`.

### `with-ca` (proxy corporativo)

```powershell
node scripts/with-ca.mjs -- node -e "fetch('https://registry.npmjs.org').then(r=>console.log(r.status))"   # → 200
node scripts/with-ca.mjs --refresh     # re-exporta %LOCALAPPDATA%\ContextPilot\ca.pem e imprime la ruta
```

Exporta las CAs raíz e intermedias (LocalMachine/CurrentUser) a `ca.pem` (se renueva cada 24 h) y fija
`NODE_EXTRA_CA_CERTS` sólo para el proceso hijo. No instala nada en el sistema.

## 3. Token y emparejamiento de la extensión

El primer arranque genera `%LOCALAPPDATA%\ContextPilot\token` (32 bytes hex). Todas las rutas salvo
`GET /health`, `/proxy/*` y `POST /otlp/v1/logs` exigen el header `X-CP-Token`.

Extensión (una vez): abrir la página de opciones de ContextPilot en Chrome/Edge y pegar el token:

```powershell
Get-Content $env:LOCALAPPDATA\ContextPilot\token | Set-Clipboard
```

El daemon acepta pedidos con `Origin: chrome-extension://…` (o sin Origin); cualquier otro origen → 403.

## 4. Hooks de Claude Code

```powershell
node scripts/install-hooks.mjs              # SessionStart, UserPromptSubmit, PreCompact, Stop
node scripts/install-hooks.mjs --dry-run    # muestra el settings.json resultante sin escribir
node scripts/install-hooks.mjs --uninstall  # quita sólo las entradas propias (hooks y statusLine)
```

- Modifica `~\.claude\settings.json` (o `$env:CLAUDE_CONFIG_DIR\settings.json`, o `--settings <ruta>`),
  preserva hooks ajenos, guarda `settings.json.cp-bak` antes del primer cambio y es idempotente.
- Cada hook ejecuta `node "<repo>/scripts/hook.mjs" <Hook>`: reenvía el JSON de stdin a
  `POST /ingest/hooks/<Hook>` con timeout de 1 s y **siempre** sale 0 sin escribir nada (si el daemon
  está caído, Claude Code no se entera).
- Los hooks sólo registran sesión ↔ transcript y aceleran la lectura; la fuente de datos es el
  transcript (`~\.claude\projects\**\*.jsonl`), así que funcionan también sin hooks.

## 5. Statusline de Claude Code

Automático (no pisa una statusline ajena sin `--force`):

```powershell
node scripts/install-hooks.mjs --statusline
```

Manual, en `~\.claude\settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "node \"C:/ruta/a/contextpilot/scripts/statusline.mjs\"", "padding": 0 }
}
```

Muestra `ctx 68% · cache 91% · ⚠ /compact` (`≈` delante de cifras estimadas). Si el daemon no
responde en 300 ms: `ContextPilot: sin datos`.

## 6. Traspaso desde la terminal

```powershell
node scripts/handoff.mjs --latest --copy        # sesión CLI activa más reciente → portapapeles
node scripts/handoff.mjs <sessionId> --print    # imprime sin tocar el portapapeles
```

El daemon lee el transcript en ese momento, redacta secretos y resume con `claude -p --model haiku`
(suscripción del usuario, timeout 60 s; corre en `%LOCALAPPDATA%\ContextPilot\handoff`, carpeta que
el tailer ignora). Sin `claude` o si falla: resumen extractivo local (`method: "extractive"`). Nada del
contenido se persiste.

## 7. Codex CLI y Gemini CLI

- Codex: automático sobre `~\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl`. Sin carpeta → health `no-data`.
- Gemini CLI: activar la telemetría a archivo en `~\.gemini\settings.json` con el instalador (CP-034.3):

  ```powershell
  node scripts/install-gemini-telemetry.mjs --dry-run    # muestra el diff, no escribe
  node scripts/install-gemini-telemetry.mjs              # escribe (backup settings.json.cp-bak una vez; idempotente)
  node scripts/install-gemini-telemetry.mjs --uninstall  # restaura el bloque telemetry previo (o lo quita)
  node scripts/install-gemini-telemetry.mjs --otlp       # alternativa: OTLP/HTTP JSON al daemon, sin archivo
  #   --outfile <ruta>  --settings <ruta>  --home <dir>
  ```

  Escribe `{ "enabled": true, "target": "local", "otlpEndpoint": "", "outfile": "<home>/.gemini/telemetry.log", "logPrompts": false }`
  (el resto de settings y otras claves de `telemetry` se conservan; `logPrompts: false` evita que el texto
  de los prompts vaya a la telemetría). `--uninstall` sólo toca un bloque que reconoce como propio. Si
  `settings.json` tiene comentarios, se pierden al escribir (quedan en el backup). A mano:

  ```json
  { "telemetry": { "enabled": true, "target": "local", "outfile": "C:/Users/<usuario>/.gemini/telemetry.log" } }
  ```

  Otra ruta: `PUT /config` con `{ "daemon": { "geminiOutfile": "…" } }`. Alternativa OTLP/HTTP JSON:
  `"otlpEndpoint": "http://127.0.0.1:47800/otlp"`, `"otlpProtocol": "http"` (el exportador agrega
  `/v1/logs`; sin verificar con un Gemini CLI real porque no está instalado en esta máquina). gRPC no soportado.

## 8. Proxy base-URL (API/SDK, opt-in)

| SDK | Variable |
| --- | --- |
| Anthropic / Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:47800/proxy/anthropic` |
| OpenAI / Codex | `OPENAI_BASE_URL=http://127.0.0.1:47800/proxy/openai/v1` |
| google-genai | `base_url="http://127.0.0.1:47800/proxy/google"` (`http_options`) |

Header opcional `X-CP-Session: <id>` para agrupar pedidos en una sesión (no viaja al upstream). La
salida respeta `HTTPS_PROXY`/`NO_PROXY` con las CAs de `with-ca`. Las API keys pasan tal cual al
upstream y nunca se loguean ni persisten.

**Limitación (RNF-08):** si el daemon está caído, la base URL apunta a nada: quitar la variable para
volver a la API directa.

## 9. Verificaciones

```powershell
node scripts/verify/idle.mjs --seconds 60     # RNF-07: RSS máx y CPU promedio de un daemon en reposo
node scripts/verify/idle.mjs --minutes 10     # criterio CP-028
node scripts/verify/idle.mjs --pid <pid>      # medir un daemon ya corriendo
npx vitest run apps/daemon                    # tests del daemon
$env:CP_TEST_CLIPBOARD=1; npx vitest run apps/daemon/test/handoff.test.ts   # incluye Set-Clipboard (restaura el portapapeles)
```

## 10. Modo equipo: exportación semanal (CP-057.1)

```powershell
node scripts/team-export.mjs --week                               # semana ISO actual, desde el daemon → stdout
node scripts/team-export.mjs --week 2026-W40 --out team-w40.json  # a archivo
node scripts/team-export.mjs --week 2026-W40 --offline --out team-w40.json   # sin daemon: lee cp.db (sql.js)
node scripts/team-export.mjs --week 2026-W40 --db C:\otra\cp.db --out t.json # otra base (implica --offline)
```

- Online: `GET /team/export?from=<lunes>&to=<lunes siguiente>` con el token de `%LOCALAPPDATA%\ContextPilot\token`
  (respeta `CONTEXTPILOT_HOME` / `CONTEXTPILOT_PORT`). Daemon caído → error que sugiere `--offline`.
- Offline: abre `cp.db` en memoria (sólo lectura) y agrega con `aggregateTeam` del core (misma proyección
  que el daemon).
- Antes de escribir se corre el test de fuga: sin hex ≥ 16, ULID/UUID, rutas, campos `sessionId`/hashes/
  embeddings, claves fuera del esquema `contextpilot.team/1` ni buckets < 5 sesiones; offline además
  ningún string de las filas de origen (ids, modelos, fechas completas). Si falla, no escribe y sale 1.
- Semana = ISO 8601 en UTC (lunes 00:00 → lunes siguiente). Los archivos se combinan en el dashboard.

## 11. Fixtures reales y replay (CP-003)

```powershell
node scripts/snapshot-fixtures.mjs                 # DRY-RUN: elige 3 sesiones recientes y verifica, no escribe
node scripts/snapshot-fixtures.mjs --write         # escribe packages/core/test/fixtures/claude-code/real-<n>.jsonl
#   --count N  --max-lines N (600)  --max-bytes N (800000)  --max-subagents N (2)  --scan N (40)
#   --projects <dir>  --out <dir>  --identity a,b (términos extra prohibidos)  --json
# alias con la ruta del backlog: node scripts/verify/snapshot-fixtures.mjs
```

- Elige sesiones cubriendo, si existen: una con subagentes, una con `ephemeral_1h_input_tokens > 0` y una
  con `tool_result` `is_error: true`; completa con las más recientes. Por sesión escribe `real-<n>.jsonl`,
  `real-<n>/subagents/agent-<k>.jsonl` y `real-<n>.expected.json` (uso esperado del parser).
- Sanitiza en dos capas: `sanitizeTranscriptLine` del core (placeholders de igual longitud) + una capa
  del script que además reemplaza claves de objetos libres (p. ej. rutas en `trackedFileBackups`), nombres
  de etiquetas `<…>` que no son de Claude Code y valores de metadato con forma de texto libre.
- Verifica: ningún término de identidad (usuario, host, segmentos de `cwd`, ramas, emails) ni ruta/email
  en el resultado; conjunto de tokens del contenido original ∩ resultado sólo con vocabulario de esquema;
  y **uso idéntico** (llamadas, tokens, herramientas y fallos) parseando original y fixture. Si algo
  falla sale 1 y no escribe nada, aun con `--write`. Revisar el diff antes de commitear.

Replay de reglas (ruido) sobre transcripts reales o fixtures, con `scripts/lib/replay.ts`:

```powershell
npx tsx scripts/replay-transcripts.ts                    # 5 sesiones más grandes (+ subagentes)
npx tsx scripts/replay-transcripts.ts --top 10 --rules R1,R2
npx tsx scripts/replay-transcripts.ts --recent 3 --json
npx tsx scripts/replay-transcripts.ts --source codex ruta\rollout-….jsonl   # archivos explícitos (claude-code | codex | gemini-cli)
```

Reporta por sesión y en total: sugerencias publicadas y suprimidas por regla, y la métrica **por hora
activa** (hora UTC con ≥ 1 turno): `activeHours`, `turns`, `calls`, `suggestionsPerActiveHour` y por regla.
`replay(files, { sourceParser, config, rules, feedback })` y `streamReplay(src, dest, { speed })` (escritura
en vivo por appends, con una línea partida) se pueden usar desde tests.

Tests de los scripts: `npx vitest run scripts/test` (usan HOME/proyectos/cp.db temporales; nunca el home real).
