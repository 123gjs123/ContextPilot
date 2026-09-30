# Informe: extensión MV3 (`apps/extension`)

Fecha: 2026-09-30 · Historias: CP-037, CP-038, CP-039, CP-040, CP-041, CP-048, CP-049 · Estado: **construida, tests AUTO en verde; pasos MANUAL pendientes**.

## Build

```
npm run build -w @contextpilot/extension     # → apps/extension/dist (cargable "sin empaquetar")
npm run typecheck -w @contextpilot/extension # tsc strict, sin errores
npx vitest run apps/extension                # 12 archivos, 67 tests
```

`build.mjs` (esbuild, IIFE, target chrome116) genera `background.js`, `content.js`, `main-world.js`, `options.js`, `sidepanel.js`, copia `static/` (HTML/CSS), dibuja los íconos PNG y escribe `manifest.json`. Al final **valida** el manifest (MV3, permisos mínimos exactos `storage`/`sidePanel`/`clipboardWrite`, hosts sólo de los 3 sitios + `http://127.0.0.1:47800/*`, `world` válido) y que **exista cada archivo referenciado** (service worker, content scripts, side panel, opciones, íconos y `src`/`href` de los HTML). Si algo falla, el build sale con código 1. `test/manifest.test.ts` repite la validación y verifica que los bundles no dependan de Node.

## Arquitectura

| Archivo | Rol |
| --- | --- |
| `src/sites.ts` | **Único** lugar con selectores DOM, endpoints de red, URLs de chat nuevo y normalización de modelos por sitio (fallbacks en orden). `SELECTORS_VERSION` a subir con cada cambio. |
| `src/entries/main-world.ts` + `src/capture/fetchWrapper.ts` | Mundo `MAIN`, `document_start`, sólo claude.ai/chatgpt.com. Envuelve `window.fetch`: devuelve **la misma promesa y el mismo `Response`** del fetch original; la copia sale de `res.clone()` (tee interno) registrada antes que la reacción de la página. Endpoints: claude.ai `POST …/chat_conversations/<id>/(retry_)completion` (y `…/completion` genérico bajo `/api/`), chatgpt.com `POST /backend-api/conversation` y `/backend-api/f/conversation`. Lee del body del pedido (sin consumirlo) prompt, `action: variant`, modelo, `system_hints`, adjuntos con `extracted_content` (hash). Parsea con `createWebStreamParser` de core. |
| `src/bridge.ts` | Nonce aleatorio por página negociado por atributo efímero en `<html>` (lo crea el primer script y lo borra el segundo, ambos antes que la página) y `window.postMessage(…, origin)`; el receptor valida `source === window`, etiqueta y nonce. |
| `src/content/controller.ts` + `src/entries/content.ts` | Mundo ISOLATED. Arma `TurnEvent` (net o DOM), detecta regeneración (clic en regenerar, `retry_completion`, `action: variant`, mismo `promptHash` reenviado), adjuntos (SHA-256 en el content script al elegir/soltar/pegar archivos; sólo hash + tokens), modo caro, sesión `<sitio>:<id de la URL>` (chatgpt: espera hasta 3 s a que aparezca `/c/<id>` o usa el `conversation_id` del stream), banner y traspaso. |
| `src/turnEvent.ts` | `input` = estimación de la conversación visible antes de la respuesta (+ prompt si aún no estaba renderizado + adjuntos); `output` = respuesta; `reasoning` = thinking visible (no suma a `contextSize`); `contextSize = input + output`; `contextWindow` de la tabla de core; `promptTokens`, `promptHash` (hash de core sobre texto normalizado), `promptEmbedding` y `blocks` **sobre el prompt redactado**; `estimated: true`. Validado contra `validateTurnEvent` de core. |
| `src/capture/domTurns.ts` | `MutationObserver` sobre el contenedor de la conversación: turno completo cuando la última respuesta no muta en 1,5 s y no hay botón de detener/indicador busy. Sólo emite si está "armado" (Enter en el compositor, clic en enviar, botón de detener visible o `net-start`), así la carga del historial no genera turnos. Health `error` si no aparece el contenedor en 10 s. Gemini: fuente primaria. claude.ai/chatgpt.com: respaldo (CP-040) si no hubo `net-start` para ese turno (gracia 2 s); tras 2 turnos seguidos sin red el estado de la pestaña pasa a `fallback-dom` (visible en el side panel). |
| `src/ui/banner.ts` | Shadow DOM, insertado como hermano previo del contenedor del compositor (`position: static`, flujo normal → nunca lo tapa), una línea con ellipsis, ≤ 2 botones (`type="button"`): acción principal («Generar resumen» para `handoff`, o la etiqueta de `copy`) + «Ignorar» (feedback `dismissed`, no reaparece). Sugerencias `quiet` no se muestran (sólo side panel). Se re-inserta si el sitio re-renderiza. Tema claro/oscuro por `prefers-color-scheme`. |
| `src/handoff.ts` | Traspaso web: texto de la conversación del DOM en el momento del clic → `redact()` → `POST /handoff` (vía service worker) → copia al portapapeles (respaldo) → pendiente efímero en `chrome.storage.local` (TTL 3 min, se consume una vez) → navega a la URL de chat nuevo → espera el compositor y **pega sin enviar** (textarea: setter nativo + `input`/`change`; contenteditable: `insertText` y, si no está disponible, párrafos + `InputEvent`). También disparable desde el side panel. |
| `src/entries/background.ts`, `src/bg/*` | Service worker: token/URL en `chrome.storage.local`; cola FIFO de 500 persistida con backoff hasta 30 s (`POST /ingest/events`, `X-CP-Token`); WS `/stream?token=` con reconexión por backoff, keepalive `{"type":"ping"}` cada 20 s (el daemon ignora tipos desconocidos) y reconexión oportunista ante cualquier mensaje de pestaña/panel/cambio de pestaña; cierre 4401 → «token rechazado»; ruteo de `suggestion`/`suggestion-cleared` a las pestañas de la sesión; badge por pestaña; estado del side panel. |
| `src/bg/badge.ts` | Verde < 50 %, amarillo 50–75 %, rojo > 75 %; texto `NN%` (≈ implícito; el tooltip dice «≈NN % … (estimado)»); `?` gris si el daemon no responde, la pestaña reporta health `error` o el adaptador `web` del daemon está en `error`/`disabled`. |
| `src/entries/sidepanel.ts`, `src/ui/panelView.ts` | Medidor con ≈ y color, turnos, modelo, sugerencia vigente (aceptar/ignorar; traspaso ejecutado por la pestaña), historial de la sesión (`GET /sessions/:id`), ahorro de la sesión y total (`GET /stats`), toggles de reglas web (`PUT /config`), estado del daemon, eventos en cola, «sin datos» cuando corresponde. Mantiene vivo el SW con un port y pings. |
| `src/entries/options.ts` | Pegar token y URL, «Probar conexión»: `GET /health` + `GET /sessions?active=true` autenticado → «Conectado ✓» / token rechazado / sin conexión. |

## Cobertura de criterios

| Criterio | Estado | Evidencia |
| --- | --- | --- |
| CP-037.1 manifest MV3 mínimo | AUTO ✓ | `build.mjs` `validateDist`, `test/manifest.test.ts` |
| CP-037.2 token → storage, WS, POST con token | implementado; AUTO parcial | `bg/daemon.ts`, `bg/stream.ts`; sin test de chrome.* |
| CP-037.3 / CP-029.3 cola 500 FIFO + backoff ≤ 30 s | AUTO ✓ | `test/queue.test.ts` |
| CP-038.1 tee sin alterar la respuesta; CP-058(b)(c) | AUTO ✓ | `test/fetchWrapper.test.ts`: mismo objeto `Response`, bytes idénticos (lectura completa y con `getReader()`, cortes multibyte), mismos argumentos al fetch original, errores de red propagados, parser que explota no rompe |
| CP-038.2 TurnEvent desde fixtures SSE | AUTO ✓ (fixtures sintéticos) | `test/webFixtures.test.ts`, `test/controller.test.ts`, `test/turnEvent.test.ts` |
| CP-038.3 otras URLs transparentes | AUTO ✓ | misma promesa, sin parser ni mensajes |
| CP-039.1 Gemini DOM con mutaciones | AUTO ✓ | `test/geminiDom.test.ts` (streaming, pausa con botón de detener, historial, armado por botón de detener, 1499/1500 ms) |
| CP-039.2 selectores aislados + health 10 s | AUTO ✓ | selectores en `src/sites.ts` (ver desvío abajo); test de health |
| CP-040.1 respaldo DOM + `fallback-dom` | AUTO ✓ | `test/controller.test.ts` |
| CP-040.2 regenerar → `regenerated` | AUTO ✓ | clic en «Reintentar» y mismo prompt |
| CP-040.3 adjuntos SHA-256 | AUTO ✓ | hash verificado contra `node:crypto`; texto no viaja |
| CP-041.1/.2 traspaso sin enviar | AUTO ✓ | `test/handoff.test.ts` en los 3 sitios + textarea: sin evento `submit`, sin keydown Enter, sin clic en enviar, sin `HTMLFormElement.submit/requestSubmit`, sin `HTMLElement.click`; conversación redactada (`sk-ant-…` → `[REDACTED:anthropic-key]`); pendiente consumido una vez |
| CP-048.1–.3 banner | AUTO ✓ | `test/banner.test.ts` en los 3 fixtures |
| CP-049.1/.3 badge | AUTO ✓ | `test/badge.test.ts` (49,9 / 50 / 75 / 75,1; `?` gris) |
| CP-049.2 side panel | AUTO ✓ (render) | `test/panelView.test.ts` |
| CP-037.4, 038.4, 039.3, 040.4, 041.3, 048.4, 049.4 | **MANUAL pendiente** | ver abajo |

## Desvíos y limitaciones

- **Selectores en `src/sites.ts`**, no en `selectors/gemini.ts` como dice CP-039.2: un solo archivo para los 3 sitios (pedido explícito). Versión en `SELECTORS_VERSION`.
- **Bounding boxes en jsdom**: jsdom no hace layout, así que CP-048.1 se verifica estructuralmente (banner = hermano previo del contenedor del compositor, fuera de él, `:host { position: static }`, sin `absolute`/`fixed`). La no superposición visual real queda en el paso MANUAL.
- **Nonce del puente**: se negocia sin exponerse en el DOM, pero una vez que se postea el primer mensaje un script de la página podría leerlo y falsificar eventos. El contenido es el de la propia página y al daemon sólo viajan métricas/hashes, así que el peor caso es una métrica falsa.
- **Toggles de reglas por sitio**: la config del daemon es global (`rules.<id>.enabled`); el panel lista las reglas web relevantes para el sitio, pero el cambio aplica a todos los chats web (se aclara en la UI).
- **Estimaciones**: todo `estimated: true`. `input` depende de lo visible en el DOM (conversaciones muy largas con virtualización pueden subestimar). En chatgpt.com el prompt se toma del body del pedido; en claude.ai del campo `prompt`.
- **Modo caro** (W4): heurístico (`paprika_mode` en claude.ai, `system_hints: research` / modelo *thinking/pro/o3* en chatgpt.com, etiqueta del modelo *Pro/Deep* en Gemini, toggles en el DOM).
- **Portapapeles**: tras la espera del `POST /handoff` puede haberse perdido la activación de usuario; si falla `navigator.clipboard`, se usa `execCommand('copy')` sobre un textarea propio. El camino principal es el pegado en el compositor.
- `scripts/verify/no-autosend.mjs` (CP-058.2) no es parte de este alcance; el código de `apps/extension/src` no contiene `.click()`, `requestSubmit`, `.submit()` ni Enter sintético (verificado con grep).

## Fixtures (SINTÉTICOS — re-grabar)

`apps/extension/test/fixtures/`: `claude-completion.sse` (+ `.expected.json`), `chatgpt-conversation.sse` (+ `.expected.json`, formato delta v1), `claude-page.html`, `chatgpt-page.html`, `gemini-conversation.html`. **Son sintéticos**, construidos según los formatos conocidos a 2025-2026. **MANUAL: deben re-grabarse desde sesiones reales** (D «verificabilidad»), reemplazando el texto por placeholders de igual longitud antes de commitear:

1. SSE: en DevTools → Network de claude.ai / chatgpt.com, filtrar `completion` / `conversation`, copiar la respuesta del stream (pestaña *EventStream* o *Response*) a `*.sse`; regenerar `*.expected.json` con el texto final, `model` y `done`.
2. DOM: con la conversación renderizada, en la consola `copy(document.documentElement.outerHTML)` y guardar como `*-page.html` / `gemini-conversation.html`; recortar scripts y estilos, mantener la estructura de mensajes, compositor, botón de enviar/detener y selector de modelo.
3. Correr `npx vitest run apps/extension`; si un selector cambió, actualizar `src/sites.ts` y subir `SELECTORS_VERSION`.

## Pasos MANUAL para el usuario

1. **Build**: `npm run build -w @contextpilot/extension`.
2. **Cargar sin empaquetar**: Chrome `chrome://extensions` (o Edge `edge://extensions`) → activar *Modo de desarrollador* → *Cargar descomprimida* → elegir `apps/extension/dist`. Verificar que no haya errores en la tarjeta de la extensión.
3. **Token**: con el daemon corriendo, abrir *Opciones* de la extensión (se abre sola al instalar si no hay token), pegar el contenido de `%LOCALAPPDATA%\ContextPilot\token`, *Guardar* → debe decir «Conectado ✓» (CP-037.4).
4. **Captura** (CP-038.4 / CP-039.3): en claude.ai, chatgpt.com y gemini.google.com hacer 3 turnos en una conversación; verificar 3 eventos en `GET /sessions/<sitio>:<id>` y que la conversación funcione igual (stream, detener, regenerar).
5. **Respaldo DOM** (CP-040.4): desactivar el script MAIN (p. ej. quitar temporalmente la primera entrada de `content_scripts` en `dist/manifest.json` y recargar); los 3 sitios deben seguir reportando turnos y el side panel mostrar «Captura por DOM (respaldo)».
6. **Banner y traspaso** (CP-048.4 / CP-041.3): con una conversación larga (o bajando el umbral de W1 vía `PUT /config`), ver el banner encima del cuadro de texto en tema claro y oscuro; «Generar resumen» debe abrir un chat nuevo con el resumen pegado, editable y **sin enviar**.
7. **Side panel y badge** (CP-049.4): clic en el ícono abre el panel en Chrome y Edge; el badge muestra el % con el color correcto; con el daemon detenido, badge `?` gris y panel «sin datos», y los sitios siguen funcionando (CP-029.4).
8. **Fixtures**: re-grabar los fixtures desde sesiones reales (sección anterior).
