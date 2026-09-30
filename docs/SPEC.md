# ContextPilot — Especificación de producto

Fuente de verdad: [documento compartido](https://claude.ai/code/artifact/e0577789-b8cd-4fea-986e-5c0cd3fcb750) · copia al 2026-09-30. Desvíos de implementación en [DECISIONS.md](DECISIONS.md).

## 1. Visión y objetivos

ContextPilot es un servicio local que observa en tiempo real las sesiones del usuario con asistentes de IA (Claude, OpenAI y Gemini, en CLI, API, web y desktop) y sugiere en el momento la acción de consumo correcta: compactar, empezar sesión nueva, cambiar de modelo o recortar entrada.

**Problema.** El consumo de tokens y de límites de plan crece por hábitos invisibles: conversaciones que se estiran sin fin, caché de prompt que expira en una pausa, salidas de herramientas enormes, modelos caros para tareas triviales.

**Objetivos**
- Reducir el consumo de tokens por tarea sin cambiar el flujo de trabajo del usuario.
- Visibilidad en vivo del estado de cada sesión: ocupación de contexto, caché, ritmo contra el límite.
- Cada sugerencia es una acción de un clic (comando copiado, resumen de traspaso listo).
- Cubrir todos los clientes con un único motor de reglas.

**No-objetivos**: modificar, bloquear o reenviar pedidos; automatizar envíos; guardar contenido de conversaciones por defecto; facturación a terceros.

## 2. Alcance

| Proveedor | CLI / agente | API / SDK | Web | Desktop |
| --- | --- | --- | --- | --- |
| Claude | Claude Code: transcripts JSONL + hooks + OTel opcional (exacto) | Proxy local vía `ANTHROPIC_BASE_URL` (exacto) | claude.ai: extensión, red SSE (estimado) | Claude Desktop: CDP sobre Electron (estimado, sujeto a spike) |
| OpenAI | Codex CLI: sessions + base URL (exacto) | Proxy local vía `OPENAI_BASE_URL` (exacto) | chatgpt.com: extensión, red SSE (estimado) | ChatGPT Desktop: método según spike |
| Gemini | Gemini CLI: telemetría OTel a archivo o colector local (exacto) | Proxy local vía `base_url` del SDK `google-genai` (exacto) | gemini.google.com: extensión, capa DOM (estimado) | Sin app nativa: cubierto por la extensión |

**Dentro de alcance:** Windows 11; Chromium (Chrome, Edge); un usuario por instalación; planes API (USD) y suscripción (límites de uso).
**Fuera de alcance (v1):** macOS/Linux; Firefox/Safari; móviles; IDEs con asistentes embebidos salvo base URL configurable; intercepción TLS sin aprobación de IT.

## 3. Usuarios y casos de uso

| Persona | Necesidad | Canal principal |
| --- | --- | --- |
| Desarrollador con agentes (Claude Code, Codex, Gemini CLI) | Sesiones largas sin degradar calidad ni quemar límite | Statusline + tray |
| Usuario intensivo de chats web | Saber cuándo abrir chat nuevo sin perder contexto | Banner + side panel |
| Líder técnico (fase 3) | Medir y difundir buenas prácticas | Dashboard agregado |

1. **CU-01 Compactar a tiempo.** Sesión de Claude Code > 60 % de ventana; statusline avisa y el tray ofrece copiar `/compact` con foco sugerido.
2. **CU-02 Volver de una pausa.** Retoma tras 40 min con 150k tokens; sugerencia de empezar de cero con traspaso.
3. **CU-03 Tarea nueva en sesión vieja.** Prompt no relacionado; se sugiere sesión nueva.
4. **CU-04 Chat web eterno.** Conversación supera el umbral estimado; banner ofrece traspaso pegado en chat nuevo.
5. **CU-05 Agente en loop.** Mismo comando fallido repetido; notificación prioritaria.
6. **CU-06 Proyección de límite.** El ritmo agota la ventana del plan; se muestra la hora estimada.
7. **CU-07 Revisión semanal.** Dashboard con sugerencias aceptadas, ahorro y reglas más disparadas.

## 4. Requerimientos funcionales

| ID | Requerimiento | Prioridad | Fase |
| --- | --- | --- | --- |
| RF-CAP-01 | Leer en vivo transcripts de Claude Code (`~/.claude/projects/**/*.jsonl`) y detectar sesiones nuevas | M | 0 |
| RF-CAP-02 | Recibir eventos de hooks de Claude Code (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`) por HTTP local | M | 0 |
| RF-CAP-03 | Leer en vivo sesiones de Codex CLI (`~/.codex/sessions/**`) | M | 0 |
| RF-CAP-04 | Leer telemetría OTel de Gemini CLI (archivo o colector OTLP local) | M | 0 |
| RF-CAP-05 | Extensión: capturar stream SSE de claude.ai y chatgpt.com envolviendo `fetch` en el contexto de la página | M | 0 |
| RF-CAP-06 | Extensión: capturar turnos de gemini.google.com por DOM (`MutationObserver`) | M | 0 |
| RF-CAP-07 | Extensión: capa DOM de respaldo para los tres sitios | S | 0 |
| RF-CAP-08 | Proxy inverso local Anthropic/OpenAI/Gemini que replica el stream sin alterarlo | M | 1 |
| RF-CAP-09 | Adaptador desktop Claude Desktop vía CDP | S | 2 |
| RF-CAP-10 | Adaptador desktop ChatGPT Desktop (según spike) | C | 2 |
| RF-NOR-01 | Convertir todo evento al esquema canónico (§8) | M | 0 |
| RF-NOR-02 | Marcar cada métrica como exacta o estimada | M | 0 |
| RF-NOR-03 | Estimar tokens con tokenizer local cuando el origen no informa uso | M | 0 |
| RF-EST-01 | Por sesión: contexto actual, ventana, proporción de caché, pausa desde último turno, tokens acumulados | M | 0 |
| RF-EST-02 | Ritmo de consumo por proveedor y plan contra la ventana de uso configurada | S | 1 |
| RF-REG-01 | Evaluar reglas en cada evento; cada regla declara fuentes y si exige tokens exactos | M | 0 |
| RF-REG-02 | Umbrales configurables por regla y proveedor | M | 0 |
| RF-REG-03 | Cooldown por regla y sesión; agrupar sugerencias simultáneas | M | 0 |
| RF-REG-04 | Ajustar prioridad según feedback (3 descartes seguidos bajan prioridad) | S | 1 |
| RF-REG-05 | Señales semánticas con embeddings locales | S | 2 |
| RF-SUG-01 | Bus WebSocket local consumido por todas las UIs | M | 0 |
| RF-SUG-02 | Toda sugerencia incluye acción de un clic | M | 0 |
| RF-SUG-03 | Registrar aceptar / ignorar / posponer | M | 0 |
| RF-HAN-01 | Resumen de traspaso con modelo local o modelo chico configurable | M | 0 |
| RF-HAN-02 | Web: abrir chat nuevo y pegar el traspaso sin enviarlo | M | 0 |
| RF-HAN-03 | CLI: copiar traspaso y comando `/clear` al portapapeles | M | 0 |
| RF-DSH-01 | Timeline por sesión con contexto, caché y sugerencias | S | 1 |
| RF-DSH-02 | Ahorro estimado acumulado por regla y proveedor | S | 1 |
| RF-CFG-01 | Perfil de plan por proveedor (API USD o suscripción con ventanas) | M | 1 |
| RF-CFG-02 | Activar/desactivar cada adaptador y regla | M | 0 |
| RF-CFG-03 | Exportar/importar configuración JSON | C | 2 |
| RF-TEAM-01 | Modo equipo: métricas agregadas y anonimizadas, sin contenido ni hashes de prompt | C | 3 |

## 5. Catálogo de reglas

Umbrales = valores de partida a calibrar.

| ID | Señal | Umbral por defecto | Sugerencia | Acción | Fuentes | Exige exacto | Fase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Ocupación de contexto | > 60 % ventana | Compactar con foco | Copiar `/compact <foco>` o `/compress` | CLI, API | No | 0 |
| R2 | Pausa > TTL de caché con contexto grande | > TTL (5 min / 1 h) y > 50k | Empezar de cero con traspaso | Traspaso + `/clear` | CLI, API | Sí | 0 |
| R3 | Caída de `cacheRead / input` | < 50 % durante 2 turnos | Algo invalida la caché | Diff de modelo/herramientas/system | CLI, API | Sí | 1 |
| R4 | Similitud prompt-sesión | coseno < 0,3 | Tarea nueva, sesión nueva | Traspaso + abrir sesión | Todas | No | 2 |
| R5 | Resultado de herramienta grande | > 10k tokens | grep/head/subagente | Mostrar ejemplo | CLI | No | 0 |
| R6 | Herramientas/MCP sin uso | 20 turnos | Desactivarlos | Listar con costo por turno | CLI | Sí | 1 |
| R7 | Tarea trivial en modelo caro | prompt < 200 y respuesta < 500 en modelo tope | Modelo más chico | Copiar `/model` | CLI, API | No | 1 |
| R8 | Comando repetido que falla | 3 seguidas | Agente en loop | Notificación prioritaria | CLI | No | 0 |
| R9 | Bloque grande repetido (hash) | 2 veces > 2k | Referenciar como archivo | — | Todas | No | 1 |
| R10 | Ritmo contra límite del plan | agotamiento proyectado antes de fin de ventana | Aviso con hora | Ver proyección | Todas | No | 1 |
| W1 | Conversación web larga | > 80k estimados o > 40 turnos | Chat nuevo con traspaso | Traspaso pegado en chat nuevo | Web, desktop | No | 0 |
| W2 | Adjunto re-subido (hash) | 2 veces | Projects/Gems/GPTs | — | Web | No | 1 |
| W3 | Regeneraciones | 3 veces | Reformular prompt | Consejos | Web | No | 0 |
| W4 | Modo caro para tarea trivial | prompt < 200 | Cambiar de modo | — | Web | No | 1 |
| G1 | Prompt cruza tramo de precio Gemini | configurable por modelo | Recortar/comprimir | Copiar `/compress` | Gemini CLI, API | Sí | 2 |
| G2 | Contexto absoluto en ventana muy grande | > 200k | Comprimir | Copiar `/compress` | Gemini | No | 2 |

Acciones por cliente: Claude Code `/compact` `/clear`; Codex `/compact` `/new`; Gemini CLI `/compress` `/clear`; web/desktop → traspaso a chat nuevo.

## 6. Requerimientos no funcionales

| ID | Categoría | Requerimiento |
| --- | --- | --- |
| RNF-01 | Privacidad | Solo métricas, hashes y embeddings por defecto; contenido solo con opt-in por fuente |
| RNF-02 | Privacidad | Redacción de secretos antes de persistir o embeber |
| RNF-03 | Seguridad | Daemon solo en `127.0.0.1`; extensión y hooks autentican con token local generado al instalar |
| RNF-04 | Seguridad | API keys del proxy nunca persistidas ni logueadas |
| RNF-05 | Performance | Proxy < 5 ms al primer byte, sin bufferizar |
| RNF-06 | Performance | Sugerencia < 1 s tras el evento |
| RNF-07 | Performance | Reposo < 100 MB RAM, < 1 % CPU |
| RNF-08 | Confiabilidad | Si el daemon cae, los clientes siguen funcionando |
| RNF-09 | Confiabilidad | Health check por adaptador; roto → «sin datos», nunca cifras falsas |
| RNF-10 | Mantenibilidad | Parsers con tests sobre fixtures y versión de formato detectada |
| RNF-11 | Entorno corporativo | Salida por el proxy corporativo con `NODE_EXTRA_CA_CERTS`; ninguna CA propia sin IT |
| RNF-12 | Cumplimiento | Solo la sesión propia; sin modificar pedidos ni automatizar envíos |
| RNF-13 | Usabilidad | Máx. una sugerencia visible por sesión; aceptación objetivo > 40 % |
| RNF-14 | Costo propio | Consumo del asesor < 2 % del ahorro estimado |

## 7. Arquitectura

Daemon local: adaptadores → normalizador (`TurnEvent`) → estado de sesión (SQLite) → motor de reglas → bus de sugerencias (WS) → UIs (statusline, tray/avisos, extensión, dashboard). Feedback vuelve por `POST /suggestions/:id/feedback`.

Flujo de un turno (Claude Code): hook `UserPromptSubmit` → daemon evalúa pausa (R2) y similitud (R4); llega respuesta → tailer lee `usage` → estado; motor evalúa reglas → `Suggestion`; statusline/tray muestran; feedback registrado.

Stack: Node.js + TypeScript; Fastify (HTTP+WS); `undici` proxy; `chokidar` tailers; SQLite; tokenizers locales; `transformers.js` MiniLM; Electron (tray, overlay, dashboard); extensión MV3 + `chrome.sidePanel`; CDP (`chrome-remote-interface`).

## 8. Contratos

```ts
interface TurnEvent {
  id: string;                 // ulid
  source: 'claude-code' | 'codex' | 'gemini-cli' | 'proxy' | 'web' | 'desktop';
  provider: 'anthropic' | 'openai' | 'google';
  client: string;             // 'claude.ai', 'chatgpt.com', 'claude-desktop', ...
  sessionId: string;
  turn: number;
  ts: string;                 // ISO 8601
  model: string;
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; estimated: boolean };
  contextSize: number;
  contextWindow: number;
  idleSincePrevMs: number;
  toolCalls?: { name: string; resultTokens: number; failed: boolean; argsHash: string }[];
  promptHash: string;
  promptEmbedding?: number[];
  attachments?: { hash: string; tokens: number }[];
  regenerated?: boolean;
}

interface Suggestion {
  id: string;
  ruleId: string;
  sessionId: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  estimatedSavingTokens?: number;
  actions: { kind: 'copy' | 'handoff' | 'open-session' | 'show-detail'; label: string; payload?: string }[];
  expiresAt: string;
}
```

Uso por proveedor: Anthropic `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`; OpenAI `input_tokens`/`prompt_tokens`, `cached_tokens`, `output_tokens`, `reasoning_tokens`; Gemini `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`.

API local (`127.0.0.1:47800`, header `X-CP-Token`):

| Método | Ruta | Uso |
| --- | --- | --- |
| POST | `/ingest/events` | `TurnEvent[]` desde extensión/adaptadores |
| POST | `/ingest/hooks/:hookName` | JSON de stdin de hooks de Claude Code |
| GET | `/sessions?active=true` | Sesiones activas |
| GET | `/sessions/:id` | Estado y timeline |
| GET | `/statusline/:sessionId` | Línea para la statusline |
| POST | `/suggestions/:id/feedback` | `accepted` / `dismissed` / `snoozed` |
| POST | `/handoff` | Resumen de traspaso |
| GET | `/health` | Estado por adaptador |
| WS | `/stream` | Push de `Suggestion` y estado |
| ANY | `/proxy/{anthropic,openai,google}/*` | Proxy transparente |

Tablas SQLite: `sessions`, `turns`, `tool_calls`, `suggestions`, `embeddings`, `settings` (columnas en el documento fuente §8).

## 9. Interfaces de usuario

| Superficie | Dónde | Muestra | Interacción | Fase |
| --- | --- | --- | --- | --- |
| Statusline | Claude Code | `ctx 68% · cache 91% · ⚠ /compact` | Solo lectura | 0 |
| Tray + overlay | Bandeja Windows | Sesiones, sugerencia vigente, acción | Aceptar/ignorar/posponer 15 min; copiar | 0 |
| Notificación | Windows | Solo `critical` (R8, R10) | Clic abre overlay | 0 |
| Banner | 3 sitios, sobre el cuadro de texto | Una línea + ≤ 2 botones | Traspaso, ignorar | 0 |
| Side panel | `chrome.sidePanel` | Medidor ≈, turnos, historial, ahorro | Detalle, reglas del sitio | 0 |
| Badge | Ícono extensión | Verde/amarillo/rojo + % | Abre side panel | 0 |
| Dashboard | App de escritorio | Timeline, ahorro por regla/proveedor, salud | Filtros, CSV | 1 |
| Dashboard · En vivo (CP-059) | App de escritorio, pestaña por defecto | Una tarjeta por sesión activa: nombre, fuente, modelo, contexto, caché, turnos, ritmo, última actividad, estado por color; «Buena práctica» o consejo; franja de plan 5 h / 7 d y R10 | Acciones de la sugerencia, aceptar/ignorar/posponer | 1 |

Reglas: cifras estimadas con «≈»; medidor verde < 50 %, amarillo 50–75 %, rojo > 75 %; el banner nunca tapa ni envía; adaptador roto → «sin datos».

## 10. Roadmap y criterios de aceptación

| Fase | Entregables | Criterios |
| --- | --- | --- |
| 0 — MVP | Daemon; tailers Claude Code/Codex/Gemini CLI; hooks; extensión 3 sitios; statusline; tray; R1, R2, R5, R8, W1, W3; traspaso web y CLI | Eventos de 3 CLIs y 3 sitios; tokens CLI = `usage` (±0 %); estimación web ±15 %; sugerencia < 1 s; cero pedidos modificados |
| 1 | Proxy base-URL ×3; dashboard; perfiles de plan; R3, R6, R7, R9, R10, W2, W4; feedback → prioridad; spike desktop | Proxy < 5 ms; proyección < 20 % error en 5 h; informe de spike |
| 2 | Adaptadores desktop; embeddings + R4; G1, G2; export/import config | R4 precisión > 80 % sobre 100 casos; desktop health verde 5 días |
| 3 | Modo equipo agregado y anonimizado | Nada de contenido ni hashes sale de la máquina; aprobación de seguridad |

## 11. Métricas de éxito

| Métrica | Objetivo |
| --- | --- |
| Tokens de entrada por sesión | −25 % vs línea base de 2 semanas |
| Aceptación de sugerencias | > 40 % |
| Sugerencias por hora activa | ≤ 3 |
| Veces que se toca el límite | −50 % |
| Proporción de caché CLI | > 80 % |
| Disponibilidad de adaptadores | > 95 % |

## 12. Riesgos y preguntas abiertas

| Riesgo | Impacto | Mitigación |
| --- | --- | --- |
| Cambian JSONL/tráfico/DOM | Alto | Parsers aislados, fixtures, health check |
| Gemini web usa `batchexecute` | Medio | DOM como fuente primaria |
| Electron fuses bloquean CDP | Medio | Spike; UI Automation o MITM con IT |
| Doble intercepción TLS | Alto | Sin MITM en v1 |
| Estimación web imprecisa | Medio | «≈»; reglas exactas no se disparan |
| Fatiga de alertas | Alto | Cooldown, una visible, feedback |
| Términos de servicio | Medio | Solo lectura propia |
| Asesor consume más de lo que ahorra | Bajo | Modelos locales; RNF-14 |

Preguntas abiertas: stack de ChatGPT Desktop; CDP en Claude Desktop; variables base URL de Gemini CLI y Codex instalados; calibración W1; modelo para traspaso; aprobación IT de la extensión.
