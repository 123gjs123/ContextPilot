# UI en vivo y coaching: feedback del QA lead (CP-059 … CP-065)

Fecha: 2026-09-30 · Base: `71b5221` (sin commit) · Windows 11, Node 24.
Historias: [BACKLOG.md E16](../BACKLOG.md) · Decisiones: [DECISIONS.md](../DECISIONS.md), últimas 5 filas · Contrato: [API.md «ronda 3»](../API.md).
El daemon real (`127.0.0.1:47800`) y la instancia real del desktop **no se tocaron**. Las capturas sintéticas usan un daemon propio (puerto 47911, `CONTEXTPILOT_HOME` temporal, transcripts y rollouts sintéticos en carpetas temporales). No se leyó la IndexedDB de Claude Desktop.

## Corridas finales

| Comando | Resultado |
| --- | --- |
| `npx vitest run` | **58 archivos, 505 pass, 1 skipped**, exit 0 (antes: 54 / 466). Nuevos: `core/coaching.test.ts`, `core/names.test.ts`, `desktop/live.test.ts`, `daemon/names-timeline.test.ts` y casos en `extension/turnEvent.test.ts` |
| `npm run typecheck` / `npm run build` | exit 0 (typecheck + extensión «dist/ listo» + `[desktop] build ok`) |
| `npx tsx scripts/replay-transcripts.ts --top 5` | 10 379 eventos, **0,43 sugerencias/h activa**; R4 0,03 → **0,02/h** (6 disparos) |
| `node scripts/verify/ui-shots.mjs …` | 8 corridas (1/4/9 sesiones, claro/oscuro, 1280×800 y 480×900): `SMOKE_OK` en todas |

## Qué se hizo

1. **«En vivo» (CP-059)** — pestaña por defecto. Una tarjeta por sesión activa, creada/actualizada/quitada con cada snapshot WS (sin refrescar). La tarjeta se actualiza en el lugar: el borde y la franja superior cambian de color con transición de 0,8 s (verde ok, ámbar atención, rojo acción sugerida, gris sin datos) y el foco del teclado se conserva. Orden estable (las nuevas entran adelante). Muestra nombre + id corto, distintivo de fuente, modelo, medidor de contexto (≈ si estimado), caché, turnos, ritmo efectivo/min y «hace N min». Arriba, franja de cuenta con barras 5 h / 7 d y el aviso R10 con sus botones. Reloj de 10 s para «hace…», cuenta regresiva y rotación.
2. **Coaching (CP-060)** — `packages/core/src/coaching.ts`: `coachingFor(ruleId, {view, suggestion, now})` → qué pasa (con números de la sesión) / por qué cuesta / qué hacer ahora / hábito, para las 16 reglas; `tipFor(view, now)` → consejo sin sugerencia (caché por vencer o vencida, contexto ≥ 45 % «cuando pase 60 %…», caché baja, modelo top, conversación web larga, hábitos). Copy revisado contra el código de cada regla (p. ej. R1 avisa por escalones de 10 puntos; R2 usa el TTL real 5 min/1 h; R4 compara con centroide y últimos 3).
3. **Nombres (CP-061)** — `displayName` «proyecto — título» en tarjetas, Sesiones, tray (menú y tooltip), overlay y título del timeline. Claude Code: `cwd` + último `ai-title` (forma verificada en sólo lectura: claves `type, aiTitle, sessionId`; título de 27 caracteres); Codex: `session_meta.cwd`; Gemini best-effort; web: sitio + título de la pestaña (extensión, cambio chico). **El título no se persiste nunca** (memoria + re-lectura del transcript); el nombre de carpeta sí (DECISIONS).
4. **Equipo (CP-062)** — encabezado con qué es, para quién, qué se exporta y qué nunca; vista previa del agregado propio (tarjetas + tablas por proveedor y por regla, con nombres de regla) antes de guardar; combinación con pasos, ejemplo y marca ⚠; aviso «pendiente H-3».
5. **Configuración (CP-063)** — por regla: nombre, qué detecta, por qué importa, qué sugiere, dónde se evalúa, umbrales con etiqueta; ⓘ con la configuración recomendada y su porqué (hover, foco o clic; Esc cierra; `aria-expanded`/`role=tooltip`; anclado a la tarjeta para no salirse en ventanas angostas) y «Restaurar recomendado». Textos de perfiles de plan y adaptadores. Fuente: `packages/core/src/ruleDocs.ts` (valores = `rule.defaults`, verificado por test).
6. **Fixes de la revisión** — (a) timeline: los eventos de subagente ya no dibujan contexto (columna `turns.sidechain`, esquema v2 con migración; heurística para filas viejas) y las series se decimán por columna de píxel (M4) sin círculos por punto en series densas; (b) R4 robusto (ver abajo).

## R4: precisión / recall (dataset `fixtures/r4/cases.json`, regla completa)

| Variante | Precisión | Recall |
| --- | --- | --- |
| Antes (centroide, coseno < 0,30) | 87,5 % (35/40) | 70,0 % |
| + mínimo 5 palabras con contenido | 87,5 % (35/40) | 70,0 % (ningún prompt del dataset tiene < 6) |
| + distinto de cada uno de los últimos 3 prompts (**final**) | **87,2 % (34/39)** | **68,0 %** |

El caso del lead («que es esto? necesito una app con un monitor, lo tienes?», 3 palabras con contenido) ya no dispara (test en `names.test.ts`, que también muestra que sin el conteo sí disparaba). Se pierde 1 verdadero positivo; ningún falso positivo nuevo.

## Capturas (`docs/reports/ui-live/`)

Sintéticas (daemon propio, `scripts/verify/ui-shots.mjs`; 9 escenarios: R1 ámbar, sana con cuenta regresiva, Codex 54 % ámbar sin sugerencia, web W1, R8 rojo, Gemini gris sin datos, R5, ChatGPT sana, R7):

| Estado | Claro | Oscuro |
| --- | --- | --- |
| 1 tarjeta, 1280×800 | `1-light-dashboard-live.png` | `1-dark-dashboard-live.png` |
| 4 tarjetas, 1280×800 | `4-light-dashboard-live.png` | `4-dark-dashboard-live.png` |
| 4 tarjetas, 480×900 | `4-narrow-light-dashboard-live.png` | — |
| 9 tarjetas, 1280×800 (vista y página entera) | `9-light-dashboard-live.png`, `9-light-dashboard-live-full.png` | `9-dark-dashboard-live.png`, `9-dark-dashboard-live-full.png` |
| 9 tarjetas, 480×900 | — | `9-narrow-dark-dashboard-live.png` |
| Timeline (sesión con ráfagas de subagente) | `9-light-dashboard-sessions-detail.png` | `9-dark-dashboard-sessions-detail.png` |
| Configuración + ⓘ | `9-light-dashboard-settings.png`, `9-light-dashboard-settings-info.png` | `9-dark-dashboard-settings-info.png`, `9-narrow-dark-dashboard-settings-info.png` |
| Equipo | `9-light-dashboard-team.png` | `9-dark-dashboard-team.png` |
| Overlay del tray (nombres) | `*-overlay.png` | |

Reales (sólo lectura, `--smoke` con `userData` propio):

- `real47800-*.png`: contra el **daemon real en 47800**. Ese daemon corre el código anterior (no manda `displayName`), así que las tarjetas caen al cliente (`claude-vscode`); se ven los datos reales, R10 real y un R5 real (nombre de herramienta MCP largo, que ahora corta bien). Los nombres aparecen cuando se reinicie el daemon real con este código.
- `real-names-*.png`: daemon **propio** (puerto 47912, home temporal) leyendo en sólo lectura los transcripts reales: **`contextpilot — …`** y **`automation-api-sportsbook — …`**. En la corrida final la sesión `contextpilot` aparece gris: su transcript principal no se escribió en > 30 min (el daemon nuevo lo salta al arrancar, comportamiento existente) y sólo hay actividad de subagente; el nombre sale igual porque ahora el `cwd` de los subagentes también da el proyecto. Estas capturas contienen **nombres de proyecto y títulos reales**: revisarlas antes de commitear.

## Pendiente / notas

- MANUAL: revisión visual del lead (CP-059.6) y H-3 (CP-062.4).
- El daemon y la app reales siguen con el código anterior hasta reiniciarlos; al reiniciar el daemon, cp.db migra a v2 (agrega `turns.sidechain`; las filas previas quedan NULL y el timeline les aplica la heurística).
- Si se abre de nuevo el dashboard en la instancia real sin reiniciarla, el renderer nuevo convive con el main viejo: las otras pestañas funcionan, pero «En vivo» queda vacía (el main viejo no manda `view` en las filas; el renderer lo ignora sin romperse): reiniciar la app.
