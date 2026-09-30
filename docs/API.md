# API local del daemon (contrato entre daemon, extensión, desktop y scripts)

Base: `http://127.0.0.1:47800`. Datos en `%LOCALAPPDATA%\ContextPilot\` (`token`, `config.json`, `cp.db`, `ca.pem`, `logs\`). Override de carpeta con env `CONTEXTPILOT_HOME`, de puerto con `CONTEXTPILOT_PORT`.

## Autenticación

- Header `X-CP-Token: <token>` (contenido de `%LOCALAPPDATA%\ContextPilot\token`, generado al primer arranque, 32 bytes hex).
- WebSocket: `ws://127.0.0.1:47800/stream?token=<token>`.
- Sin token: `GET /health`, `/proxy/*`, `POST /otlp/v1/logs` (sólo loopback).
- Requests con header `Origin` sólo se aceptan si el origin es `chrome-extension://*` o `file://` / ausente. Cualquier otro → 403.

## Tipos

Los de `packages/core/src/types.ts` (`TurnEvent`, `Suggestion`, `AdapterHealth`, `Config`, `PlanProfile`) y `SessionView` de `packages/core/src/state.ts`.

## Endpoints

| Método | Ruta | Body / query | Respuesta |
| --- | --- | --- | --- |
| POST | `/ingest/events` | `TurnEvent[]` (campos obligatorios validados; `id`/`ts` se completan si faltan) | `{ accepted: number, suggestions: Suggestion[] }` |
| POST | `/ingest/hooks/:hookName` | JSON de stdin del hook de Claude Code tal cual (`session_id`, `transcript_path`, `hook_event_name`, `prompt`...) | `{ ok: true }` |
| GET | `/sessions?active=true` | — | `SessionView[]` (activa = último turno < 30 min) |
| GET | `/sessions/:id` | — | `{ view: SessionView, timeline: {ts, contextSize, cacheRatio, input, output, cacheRead, cacheWrite, estimated}[], suggestions: (Suggestion & {feedback?})[] }` |
| GET | `/statusline/:sessionId` | — | `text/plain`, una línea: `ctx 68% · cache 91% · ⚠ /compact` o `ctx ≈45%` o `sin datos` |
| GET | `/suggestions?sessionId=&active=true` | — | `Suggestion[]` |
| POST | `/suggestions/:id/feedback` | `{ feedback: 'accepted' \| 'dismissed' \| 'snoozed' }` | `{ ok: true }` |
| POST | `/handoff` | `{ sessionId: string, content?: string }` (`content` lo manda la extensión con el texto de la conversación ya extraído del DOM; para CLIs el daemon lee el transcript) | `{ summary: string, command?: string, method: 'claude-cli' \| 'extractive' }` |
| GET | `/health` | — | `AdapterHealth[]` |
| GET / PUT | `/config` | `Partial<Config>` en PUT (merge) | `Config` |
| GET | `/config/export` | — | `Config` como adjunto JSON |
| POST | `/config/import` | `Config` | `Config` (validado) |
| GET | `/stats?from=&to=` | — | `{ byRule: {ruleId, fired, accepted, dismissed, snoozed, savedTokens}[], byProvider: {provider, sessions, input, output, cacheRead, cacheWrite, savedTokens}[], acceptanceRate, suggestionsPerActiveHour }` |
| GET | `/team/export` | — | Agregado anónimo (ver DECISIONS: sin ids, sin hashes, buckets < 5 sesiones suprimidos) |
| POST | `/otlp/v1/logs` | OTLP/HTTP JSON | `{}` |
| ANY | `/proxy/anthropic/*`, `/proxy/openai/*`, `/proxy/google/*` | passthrough a `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com` | respuesta upstream sin modificar |

## Mensajes WebSocket (`/stream`)

Servidor → cliente, JSON por mensaje:

```ts
type ServerMsg =
  | { type: 'hello'; data: { version: string; sessions: SessionView[]; suggestions: Suggestion[]; health: AdapterHealth[] } }
  | { type: 'session'; data: SessionView }
  | { type: 'suggestion'; data: Suggestion }
  | { type: 'suggestion-cleared'; data: { id: string; sessionId: string; feedback?: 'accepted' | 'dismissed' | 'snoozed' | 'expired' } }
  | { type: 'health'; data: AdapterHealth[] };
```

Cliente → servidor: `{ type: 'feedback', data: { id, feedback } }` (equivalente al POST).

## Convenciones de sessionId

- Claude Code: `session_id` del transcript. Codex: id del archivo de sesión. Gemini CLI: `session.id` de la telemetría.
- Web: `<sitio>:<conversationId>` (p. ej. `claude.ai:0f3c…`, `chatgpt.com:68ab…`, `gemini.google.com:c_91…`).
- Desktop: `claude-desktop:<conversationId>`.
- Proxy: header `X-CP-Session` o hash (DECISIONS).
