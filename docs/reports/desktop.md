# Reporte — apps/desktop (tray, overlay, notificaciones, dashboard, adaptador CDP)

Fecha: 2026-09-30 · Alcance: sólo `apps/desktop` (+ `docs/SPIKE-desktop.md`). Sin commits.

## Qué hay

| Pieza | Archivo(s) |
| --- | --- |
| Build esbuild (main CJS node, preload CJS, renderer IIFE) → `apps/desktop/out/` | `apps/desktop/build.mjs` · `npm run build -w @contextpilot/desktop` |
| Lanzador | `apps/desktop/scripts/start.mjs` (quita `--use-system-ca` de `NODE_OPTIONS` sólo para Electron) · `npm run start -w @contextpilot/desktop` · `npm run smoke -w …` |
| Lógica pura (testeada) | `src/shared/`: `store.ts` (WS → estado, 1 sugerencia por sesión), `view.ts` (color del tray, tooltip, menú, filas de overlay, «sin datos»), `notify.ts`, `actions.ts` (copy/handoff/…), `stats.ts` (KPIs, filtros), `csv.ts`, `timeline.ts` (SVG), `configForm.ts` (Config ↔ form, presets, diff), `team.ts`, `fuses.ts`, `planUsage.ts`, `backoff.ts` |
| Main (Electron fino) | `src/main/main.ts` (tray, overlay, dashboard, notificaciones, IPC), `daemonClient.ts` (HTTP + WS con backoff), `icon.ts` (PNG generado en código), `settings.ts` (token, puerto, allowlist de rutas), `daemonSpawn.ts`, `planUsageFile.ts` |
| Preload | `src/preload/preload.ts` (contextBridge `window.cp`; el renderer nunca ve el token) |
| Renderer | `src/renderer/overlay.*`, `dashboard.*`, `styles.css` (tokens claro/oscuro) |
| CDP | `src/cdp/capture.ts` (Network.* → TurnEvent), `claudeSse.ts` (parser SSE), `claudeDesktop.ts` (launcher, conexión CRI, allowlist read-only) |

## Historias

| Historia | Estado | Verificación |
| --- | --- | --- |
| CP-042 spike | Hecho → `docs/SPIKE-desktop.md` | Claude Desktop 2.16120 (MSIX, Electron 44.4.3) **rechaza `--remote-debugging-port`** (salida 1) salvo token `CLAUDE_CDP_AUTH` firmado por Anthropic; fuses `010011011`. ChatGPT Desktop no instalado. **Requiere escalar al humano** (D «Adaptadores desktop»). |
| CP-043 adaptador Claude Desktop | Implementado; bloqueado en esta máquina | AUTO: CDP simulado (`test/cdp.test.ts`): source/client, sin contenido, acumulado, retry, base64, allowlist `Network.enable`/`getResponseBody`. Health `no-data` + reintento 60 s; `error` con motivo si la app rechaza el switch. MANUAL «health verde 5 días»: imposible con esta versión. |
| CP-044 ChatGPT Desktop | `won't` (por ahora) | Sin app instalada; ver spike. |
| CP-046 tray + overlay | Hecho | AUTO: store/view/actions. SMOKE ok. MANUAL: ícono en bandeja, clic → overlay, copiar/traspaso/aceptar/ignorar/posponer contra un daemon real. |
| CP-047 notificaciones | Hecho | AUTO: sólo `critical` no `quiet`, dedupe por id. MANUAL: toast de Windows y clic → overlay con la sugerencia resaltada. |
| CP-050 timeline + salud | Hecho | AUTO: modelo/SVG del timeline, filtros. Visual verificado con daemon simulado (captura). MANUAL: abrir desde tray con datos reales. |
| CP-051 ahorro/métricas/CSV | Hecho | AUTO: view-models, consumo del asesor rojo ≥ 2 %, CSV sin contenido. MANUAL: revisión con 1 semana de datos. |
| CP-055 UI perfiles de plan | Hecho | AUTO: API USD / suscripción (ventana h + límite), presets «a calibrar», validación. |
| CP-056 UI export/import | Hecho | AUTO: diff. Import: `POST /config/import?dryRun=true` → diff → `dryRun=false`. |
| CP-057 UI equipo | Hecho | AUTO: combinar N archivos, avisos de privacidad (hex ≥ 16, ULID/UUID, rutas, sessionId). Exportar: `GET /team/export` → archivo. MANUAL: aprobación de seguridad. |

## Pruebas
- `npx vitest run apps/desktop` → **7 archivos, 65 tests OK**.
- `npx tsc -p apps/desktop/tsconfig.json` → sin errores.
- **Smoke**: `npm run smoke -w @contextpilot/desktop` → `SMOKE_OK tray=true overlay=true dashboard=true connection=unavailable` (sin daemon). Con un daemon simulado en `CONTEXTPILOT_PORT=47899` → `connection=connected`; capturas (`--smoke-shot=<dir>`) revisadas: overlay con medidor/≈/«sin datos»/acciones y dashboard con timeline, sugerencias y salud.

## Configuración (sin daemon por defecto)
- Token: `%LOCALAPPDATA%\ContextPilot\token` (o `CONTEXTPILOT_HOME`); puerto `CONTEXTPILOT_PORT` (47800).
- `desktop.json` en esa carpeta: `{ spawnDaemon: false, daemonCommand?, cdpPort: 9339, cdpAttachOnStart: false, notifications: true }`. Env: `CONTEXTPILOT_SPAWN_DAEMON=1`, `CONTEXTPILOT_CDP_ATTACH=1`, `CONTEXTPILOT_CDP_PORT`. El spawn usa `node --import tsx apps/daemon/src/main.ts` (log en `logs\daemon-desktop-spawn.log`).

## Extras del spike
- `plan-usage-history.json` de Claude Desktop (uso del plan 5 h / 7 días, cada ~15 min) se lee en modo sólo lectura y se muestra en el overlay. Es un dato del proveedor, candidato a alimentar R10 en el daemon.

## Supuestos / pendientes para otros agentes
- **Core**: no exporta todavía `createWebStreamParser`; `src/cdp/claudeSse.ts` lo detecta en runtime (duck typing `push|feed` / `end|finish`) y si falta usa un parser local mínimo. Cuando exista, confirmar la forma.
- **Daemon**:
  - `AdapterHealth.name` se asume igual a la fuente (`claude-code`, `web`…) o con prefijo `fuente:`/`fuente-` para mapear sesión → «sin datos».
  - `GET /sessions` (sin `active`) debe devolver todas las sesiones (filtros de fecha en el cliente).
  - `GET /sessions/:id` → las sugerencias deberían traer `createdAt` para ubicarlas en el timeline.
  - `/stats` puede sumar `advisorTokens` (RNF-14); sin eso el KPI muestra «sin datos».
  - `/team/export`: el importador acepta `{rows:[{week,provider?,ruleId?,sessions,inputTokens,outputTokens,cacheReadTokens,suggestions,accepted,savedTokens}]}` o `{byProvider, byRule}`.
  - `POST /config/import?dryRun=true|false`.
- `ws` de la raíz es 7.5.13; el main usa el `WebSocket` global de Electron 44 (Node 24) y cae a `ws` sólo si falta.

## Riesgos / notas
- Toasts de Windows sin instalador: `setAppUserModelId('ContextPilot')`; en dev pueden aparecer con otro nombre o no mostrarse sin acceso directo en el menú Inicio (MANUAL).
- El switch de Claude Desktop sólo se probó con un puerto libre; la app lo rechazó antes de iniciar y las instancias abiertas no se tocaron.
