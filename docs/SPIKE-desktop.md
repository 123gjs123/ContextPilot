# Spike desktop (CP-042) — Claude Desktop y ChatGPT Desktop

Fecha: 2026-09-30 · Máquina: Windows 11 Pro 10.0.26200 · Autor: agente desktop.
(El BACKLOG cita `docs/spikes/desktop.md`; este archivo cumple ese rol.)

## Resumen

| App | Instalada | Stack | CDP `--remote-debugging-port` | Recomendación |
| --- | --- | --- | --- | --- |
| Claude Desktop 2.16120.0 | Sí (MSIX) | Electron 44.4.3 | **Rechazado por la app** (sale con código 1) salvo token firmado por Anthropic | CDP **no viable** sin intervención del proveedor. Descartar CDP; alternativas en §Alternativas. Escalar al humano (D «Adaptadores desktop»). |
| ChatGPT Desktop | **No** | — | No evaluable | CP-044 cerrar `won't` por ahora (sin app para evaluar); re-abrir si se instala. |

## Claude Desktop

### Instalación
- Paquete MSIX: `Get-AppxPackage` → `Name=Claude`, `Version=2.16120.0.0`, `PackageFamilyName=Claude_pzs8sxrjxfjjc`.
- Ruta: `C:\Program Files\WindowsApps\Claude_2.16120.0.0_x64__pzs8sxrjxfjjc\app\claude.exe` (manifest: `Executable="app\Claude.exe"`, `runFullTrust`, protocolo `claude:`).
- No hay instalación Squirrel en `%LOCALAPPDATA%\AnthropicClaude` ni en `%LOCALAPPDATA%\Programs`.
- Datos de la app (virtualizados por MSIX): `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\` (logs, `config.json`, `claude_desktop_config.json`, `plan-usage-history.json`, perfiles Chromium).

### Stack
- Electron: `app\version` = `44.4.3`; `app\resources\app.asar` (41,8 MB) + `app.asar.unpacked`; binario con `Electron/44.4.3`.

### Fuses (lectura por byte-search del centinela `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`)
Offset 199 378 104 en `claude.exe`, versión 1, 9 fuses, bytes `010011011`:

| # | Fuse | Estado |
| --- | --- | --- |
| 0 | RunAsNode | off |
| 1 | EnableCookieEncryption | on |
| 2 | EnableNodeOptionsEnvironmentVariable | off |
| 3 | EnableNodeCliInspectArguments | off |
| 4 | EnableEmbeddedAsarIntegrityValidation | on |
| 5 | OnlyLoadAppFromAsar | on |
| 6 | LoadBrowserProcessSpecificV8Snapshot | off |
| 7 | GrantFileProtocolExtraPrivileges | on |
| 8 | WasmTrapHandlers | on |

Consecuencia: no hay `--inspect`, ni `ELECTRON_RUN_AS_NODE`, ni `NODE_OPTIONS`, y el asar tiene validación de integridad (no se puede parchear). `--remote-debugging-port` es un switch de Chromium, no un fuse: lo bloquea el código de la app (abajo).

Parser reproducible: `apps/desktop/src/shared/fuses.ts` (test con buffer sintético).

### `--remote-debugging-port`
Inspección estática de `app.asar` (sólo lectura): el main process define una lista de switches prohibidos

```
remote-debugging-port, remote-debugging-pipe, ignore-certificate-errors, host-resolver-rules, host-rules,
disable-web-security, log-net-log, net-log-capture-mode, ssl-key-log-file, renderer-cmd-prefix, …
```

y al arrancar hace `if (fZ(process.argv) && !yZ()) { stderr("Claude: refusing to start — a debugging or network-override switch is present on the command line."); process.exit(1) }`. `yZ()` sólo es verdadero con `CLAUDE_CDP_AUTH` = `<timestamp>.<base64(userDataDir)>.<firma>` verificada con una clave pública Ed25519 embebida (válida 5 min) y `CLAUDE_USER_DATA_DIR`. Además, en builds empaquetados borra `SSLKEYLOGFILE`.

Prueba empírica (con la app del usuario abierta, sin tocarla): `claude.exe --remote-debugging-port=9339` → **sale con código 1** en < 1 s con el mensaje anterior; el puerto 9339 nunca abre (`ECONNREFUSED`). Las instancias existentes siguieron corriendo.

### Endpoints de red observables (estático)
La app usa los mismos endpoints que claude.ai: `/api/organizations/{org}/chat_conversations/{id}/completion` (+ `retry_completion`, `completion2`) — regex idéntica en el código de la app. Sin CDP no son observables desde afuera sin MITM.

### Alternativas evaluadas
| Vía | Lectura | Requiere | Veredicto |
| --- | --- | --- | --- |
| CDP (`--remote-debugging-port`) | Red completa (SSE) | Token firmado por Anthropic | **Bloqueado** |
| `--inspect` / `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` | — | Fuses | Bloqueado por fuses |
| Parchear asar / inyectar | — | Rompe integridad; viola RNF-12 | Descartado |
| MITM TLS | Red completa | CA propia + IT; D «Sin MITM en v1» | Escalar; no se implementa |
| UI Automation (árbol de accesibilidad de Chromium) | Texto visible de la conversación → tokens ≈ | Nada especial (sólo lectura); Chromium expone accesibilidad a clientes UIA | **Recomendada para un spike 2**: viable y read-only, estimación como la capa DOM web |
| `plan-usage-history.json` | Uso del plan: muestras cada ~15 min `{t, org, u:{fh, sd}}` (% ventana 5 h y 7 días) | Lectura de archivo local | **Viable ya**: implementado en el tray (sólo lectura). Útil para R10 / CU-06 (dato del proveedor, no estimado) |
| Sincronización con claude.ai | Las conversaciones de desktop aparecen en claude.ai | Extensión en el navegador | No es en vivo; no sirve para sugerencias en el momento |

### Recomendación
- **Claude Desktop vía CDP: no viable** en la versión instalada. Según DECISIONS («Adaptadores desktop … si el spike exige MITM, cambios de fuses o intervención de IT, se escala y la historia se cierra `won't`») → **escalar al humano**. El adaptador CP-043 quedó implementado y testeado con CDP simulado (sirve si Anthropic habilita un modo de depuración o una política corporativa lo permite), pero en esta máquina reporta health `error` con el motivo al intentarlo.
- Próximo paso sugerido: spike UI Automation (lectura del árbol de accesibilidad) como fuente `desktop` estimada, y usar `plan-usage-history.json` como señal exacta de consumo de plan para R10.

## ChatGPT Desktop
- `Get-AppxPackage` sin coincidencias para `openai|chatgpt`; sin carpeta en `%LOCALAPPDATA%\Programs`, ni en `WindowsApps`, ni accesos en el menú Inicio.
- No se puede determinar stack ni fuses. Referencia pública: la app de Windows se distribuye por Microsoft Store; si fuera Electron aplicaría el mismo análisis de fuses/switches.
- **CP-044: `won't` (por ahora)** — no hay vía de lectura evaluable sin la app; sin MITM. Re-abrir si se instala: correr `parseFuses` sobre el exe y probar el switch en un puerto libre.

## Cómo reproducir
```powershell
Get-AppxPackage | ? Name -match 'claude|openai|chatgpt'
node -e "const b=require('fs').readFileSync(process.argv[1]);const s='dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';const i=b.indexOf(s);console.log(b.slice(i+34,i+34+b[i+33]).toString('latin1'))" "<ruta>\app\claude.exe"
```
