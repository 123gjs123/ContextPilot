# Trazabilidad — requerimiento → historias → tests

Fuente: [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · verificación: [ACCEPTANCE.md](ACCEPTANCE.md). Actualizado: 2026-09-30, **ronda 2** (commit `7f00517`; ronda 1 en `5b805e3`).
Columna **Tests / archivos**: rutas abreviadas — `core/` = `packages/core/test/`, `daemon/` = `apps/daemon/test/`, `desktop/` = `apps/desktop/test/`, `ext/` = `apps/extension/test/`, `scripts/test/` (incluidos en `npm test` desde D-20), `verify/` = `scripts/verify/`. Estado por criterio en ACCEPTANCE.md §2 (ronda 1) y §7.3 (ronda 2).
Columna **Estado**: ✓ cumplido con evidencia · ◐ parcial · ✗ falta · ⏸ requiere paso MANUAL/humano.

## Requerimientos funcionales

| Req | Fase | Historias | Verificación | Tests / archivos | Estado | Notas |
| --- | --- | --- | --- | --- | --- | --- |
| RF-CAP-01 | 0 | CP-030, CP-031 | AUTO | `core/parsers/claudeCode.test.ts`, `daemon/tailer.test.ts`, `verify/real-transcripts-usage.ts` | ✓ | 320 transcripts reales, 14 455 llamadas, ±0 tokens. Daemon real corriendo sobre `~/.claude/projects` |
| RF-CAP-02 | 0 | CP-032 | AUTO | `daemon/hooks.test.ts` | ✓ | Instalado en el `settings.json` real (H-2); `/health hooks: ok` |
| RF-CAP-03 | 0 | CP-033 | MIXTA | `core/parsers/codex.test.ts`, `daemon/tailer.test.ts` | ◐ ⏸ | Codex CLI 0.159.2 instalado; falta login y sesión real |
| RF-CAP-04 | 0 | CP-034 | MIXTA | `core/parsers/geminiTelemetry.test.ts`, `daemon/tailer.test.ts`, `scripts/test/install-gemini-telemetry.test.ts` | ✓ ⏸ | Instalador entregado; Gemini CLI 0.62.0 instalado, falta login y sesión real |
| RF-CAP-05 | 0 | CP-038 | MIXTA | `ext/fetchWrapper.test.ts`, `ext/controller.test.ts`, `ext/webFixtures.test.ts`, `core/parsers/web.test.ts` | ◐ ⏸ | Fixtures SSE sintéticos; falta sesión real (H-4) |
| RF-CAP-06 | 0 | CP-039 | MIXTA | `ext/geminiDom.test.ts` | ◐ ⏸ | Fixture HTML sintético |
| RF-CAP-07 | 0 | CP-040 | MIXTA | `ext/controller.test.ts` | ◐ ⏸ | |
| RF-CAP-08 | 1 | CP-035, CP-036 | AUTO (+1 MANUAL) | `daemon/proxy.test.ts`, `daemon/proxy-providers.test.ts`, `core/parsers/sse.test.ts` | ✓ ⏸ | Anthropic, OpenAI y Google de punta a punta; `claude -p` real pendiente (CP-035.6) |
| RF-CAP-09 | 2 | CP-042, CP-043 | MIXTA | `desktop/cdp.test.ts`, `desktop/cdp-retry.test.ts`, `desktop/misc.test.ts` (fuses), `docs/SPIKE-desktop.md`, `docs/SPIKE-desktop-traffic.md` | ✗ bloqueado | CDP rechazado; spike 2 propone IndexedDB (H-1) |
| RF-CAP-10 | 2 | CP-042, CP-044 | MANUAL | `docs/SPIKE-desktop.md` | won't (provisorio) | ChatGPT Desktop no instalado |
| RF-NOR-01 | 0 | CP-003, CP-004, CP-030, CP-033, CP-034, CP-036 | AUTO | `core/validate.test.ts`, `core/parsers/*.test.ts`, `ext/turnEvent.test.ts`, `scripts/test/replay.test.ts`, `scripts/test/snapshot-fixtures.test.ts` | ◐ | Snapshot y replay entregados; fixtures reales sin escribir ni commitear (D-7) |
| RF-NOR-02 | 0 | CP-005, CP-030, CP-038 | AUTO | `core/parsers/claudeCode.test.ts`, `ext/turnEvent.test.ts`, `desktop/cdp.test.ts` | ✓ | |
| RF-NOR-03 | 0 | CP-005, CP-038 | AUTO | `core/misc.test.ts`, `verify/estimator-abs.ts`, `scripts/verify-estimator.ts` | ✓ (Anthropic) | Mediana \|err\| 4,9 %, p90 17,1 %; +17 % en salidas con URLs (D-23) |
| RF-EST-01 | 0 | CP-007, CP-023, CP-025, CP-045, CP-049 | AUTO | `core/state.test.ts`, `daemon/fixes1.test.ts`, `daemon/storage.test.ts`, `daemon/routes.test.ts`, `daemon/planUsage.test.ts`, `ext/badge.test.ts`, `ext/panelView.test.ts` | ✓ | Statusline real `⚠ grep/head` (D-3 cerrado) |
| RF-EST-02 | 1 | CP-018, CP-055 | AUTO | `core/projection.test.ts`, `core/fixes1.test.ts`, `daemon/fixes1.test.ts`, `daemon/planUsage.test.ts`, `verify/r10-replay-cooldown.ts`, `apps/daemon/scripts/eval-projection.ts` | ◐ | Ritmo/proyección expuestos; R10 no emite tras reinicio (D-19); ritmo cuenta `cacheRead` ×1 (D-21); error real a 1 h 26,8 % |
| RF-REG-01 | 0 | CP-008, CP-024 | AUTO | `core/engine.test.ts`, `daemon/pipeline.test.ts` | ✓ | |
| RF-REG-02 | 0 | CP-008, CP-054 | AUTO | `core/engine.test.ts`, `daemon/routes.test.ts` | ✓ | |
| RF-REG-03 | 0 | CP-009 | AUTO | `core/engine.test.ts`, `core/fixes1.test.ts` | ✓ | Lugar de cuenta separado (D-1) |
| RF-REG-04 | 1 | CP-014 | AUTO | `core/engine.test.ts`, `daemon/pipeline.test.ts` | ✓ | |
| RF-REG-05 | 2 | CP-019 | AUTO | `core/misc.test.ts` (embed), `core/r4.dataset.test.ts`, `core/fixes1.test.ts` | ◐ | 100 casos sintéticos, precisión 87,5 %; `transformers.js` no implementado (H-8) |
| RF-SUG-01 | 0 | CP-026, CP-037, CP-046 | AUTO | `daemon/pipeline.test.ts`, `daemon/routes.test.ts`, `desktop/store.test.ts` | ✓ | SW de la extensión sin test (CP-037.2) |
| RF-SUG-02 | 0 | CP-004, CP-046, CP-048 | AUTO | `core/validate.test.ts`, `core/engine.test.ts`, `desktop/notify-actions.test.ts`, `ext/banner.test.ts` | ✓ | |
| RF-SUG-03 | 0 | CP-023, CP-026, CP-046 | AUTO | `daemon/storage.test.ts`, `daemon/pipeline.test.ts`, `daemon/routes.test.ts`, `desktop/account-overlay.test.ts` | ✓ | |
| RF-HAN-01 | 0 | CP-052 | MIXTA | `daemon/handoff.test.ts` | ✓ ⏸ | Calidad con `claude -p` real: MANUAL |
| RF-HAN-02 | 0 | CP-041 | MIXTA | `ext/handoff.test.ts` | ✓ ⏸ | |
| RF-HAN-03 | 0 | CP-046, CP-053 | AUTO | `desktop/notify-actions.test.ts`, `daemon/handoff.test.ts` | ✓ ⏸ | Test de portapapeles real gated (`CP_TEST_CLIPBOARD=1`) |
| RF-DSH-01 | 1 | CP-050 | MIXTA | `desktop/misc.test.ts` (timeline), `desktop/stats-csv.test.ts` (filtros) | ◐ ⏸ | Panel de salud sin test |
| RF-DSH-02 | 1 | CP-021, CP-051 | MIXTA | `core/savings.test.ts`, `desktop/stats-csv.test.ts`, `daemon/routes.test.ts` | ✓ ⏸ | |
| RF-CFG-01 | 1 | CP-055 | AUTO | `daemon/routes.test.ts`, `daemon/fixes1.test.ts`, `desktop/config-team.test.ts` | ✓ | 5 h + 7 días |
| RF-CFG-02 | 0 | CP-049, CP-054 | AUTO | `daemon/routes.test.ts`, `daemon/fixes1.test.ts`, `core/engine.test.ts`, `ext/panelView.test.ts` | ◐ | Toggles del panel por `PUT /config` sin test |
| RF-CFG-03 | 2 | CP-056 | AUTO | `daemon/routes.test.ts`, `desktop/config-team.test.ts` | ✓ | |
| RF-TEAM-01 | 3 | CP-057 | MIXTA | `core/team.test.ts`, `daemon/routes.test.ts`, `desktop/config-team.test.ts`, `scripts/test/team-export.test.ts` | ✓ ⏸ | Aprobación de seguridad (H-3) |

## Catálogo de reglas

| Regla | Fase | Historias | Verificación | Tests / archivos | Estado | Notas |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 0 | CP-010 | AUTO | `core/rules.test.ts`, `core/fixes1.test.ts`, `core/parsers/claudeCodeInventory.test.ts`, `daemon/fixes1.test.ts` | ✓ | `warn` desde 60 %, `/compact <foco>` (D-2); visible con plan-usage (D-1) |
| R2 | 0 | CP-011 | AUTO | `core/rules.test.ts`, `core/fixes1.test.ts`, `daemon/pipeline.test.ts`, `daemon/fixes1.test.ts` | ✓ | Una emisión por pausa (D-18); 0,12/h activa |
| R3 | 1 | CP-015 | AUTO | `core/rules.test.ts`, `core/fixes1.test.ts` | ✓ | System prompt sólo observable por proxy |
| R4 | 2 | CP-019 | AUTO | `core/r4.dataset.test.ts`, `core/fixes1.test.ts`, `core/misc.test.ts` | ✓ | Dataset sintético (87,5 %); validar con prompts reales |
| R5 | 0 | CP-010 | AUTO | `core/rules.test.ts`, `core/fixes1.test.ts` | ✓ | Disparo real legítimo (ACCEPTANCE §7.2 c) |
| R6 | 1 | CP-015 | AUTO | `core/fixes1.test.ts`, `core/parsers/claudeCodeInventory.test.ts`, `daemon/proxy-providers.test.ts` | ✓ | Claude Code ≈ inventario MCP; proxy exacto; Codex/Gemini «no evaluable» en health |
| R7 | 1 | CP-016 | AUTO | `core/rules.test.ts` | ◐ | `tier` no configurable (D-14) |
| R8 | 0 | CP-012, CP-047 | AUTO (+ notificación MANUAL) | `core/rules.test.ts`, `core/fixes1.test.ts`, `core/parsers/codex.test.ts`, `desktop/notify-actions.test.ts` | ✓ ⏸ | |
| R9 | 1 | CP-017 | AUTO | `core/rules.test.ts`, `core/misc.test.ts` (splitBlocks) | ✓ | |
| R10 | 1 | CP-018, CP-047 | AUTO | `core/fixes1.test.ts`, `core/projection.test.ts`, `daemon/fixes1.test.ts`, `daemon/planUsage.test.ts`, `verify/r10-replay-cooldown.ts` | ✗ en producción | Unitario ✓; silenciada tras reinicio (D-19), visibilidad (D-22), ritmo (D-21) |
| W1 | 0 | CP-013, CP-048 | AUTO | `core/rules.test.ts`, `ext/banner.test.ts` | ✓ | Umbral 80k sin calibrar |
| W2 | 1 | CP-017, CP-040 | AUTO | `core/fixes1.test.ts`, `daemon/fixes1.test.ts`, `ext/controller.test.ts` | ✓ | Índice por sitio, 7 días (D-11) |
| W3 | 0 | CP-013, CP-040, CP-048 | AUTO | `core/rules.test.ts`, `ext/controller.test.ts`, `ext/fetchWrapper.test.ts` | ✓ | |
| W4 | 1 | CP-016 | AUTO | `core/rules.test.ts`, `ext/fetchWrapper.test.ts`, `ext/turnEvent.test.ts` | ✓ | |
| G1 | 2 | CP-020 | AUTO | `core/rules.test.ts` | ✓ | |
| G2 | 2 | CP-020 | AUTO | `core/rules.test.ts` | ✓ | |

## Requerimientos no funcionales

| Req | Historias | Verificación | Tests / archivos | Estado | Notas |
| --- | --- | --- | --- | --- | --- |
| RNF-01 | CP-006, CP-052, CP-054, CP-057 | AUTO | `daemon/storage.test.ts`, `daemon/pipeline.test.ts`, `daemon/handoff.test.ts`, `daemon/fixes1.test.ts` (foco), `core/team.test.ts`, `core/parsers/sanitize.test.ts`, `ext/turnEvent.test.ts`, `desktop/cdp.test.ts` | ✓ | Fuga sobre `cp.db`, exportaciones y fixtures sanitizados |
| RNF-02 | CP-006, CP-052 | AUTO | `core/misc.test.ts`, `daemon/handoff.test.ts`, `ext/handoff.test.ts` | ✓ | |
| RNF-03 | CP-022, CP-032, CP-037 | AUTO | `daemon/routes.test.ts`, `daemon/fixes1.test.ts`, `daemon/hooks.test.ts` | ◐ | `allowedExtensionIds` implementado; default permisivo hasta H-5 |
| RNF-04 | CP-035 | AUTO | `daemon/proxy.test.ts`, `daemon/proxy-providers.test.ts` | ✓ | Las 4 credenciales, incluso con upstream caído |
| RNF-05 | CP-035 | AUTO | `daemon/proxy.test.ts` (`CP_PERF_STRICT=1`) | ✓ | Primer byte p95 1,51 ms; +0,56 ms por chunk |
| RNF-06 | CP-024, CP-031 | AUTO | `daemon/pipeline.test.ts`, `daemon/tailer.test.ts`, `daemon/fixes1.test.ts` | ✓ | |
| RNF-07 | CP-028 | AUTO | `verify/idle.mjs --minutes 10` | ✓ | Ronda 1: RSS 90,3 MB, CPU 0,4 % (no re-medido en ronda 2) |
| RNF-08 | CP-029, CP-037, CP-045 | MIXTA | `daemon/hooks.test.ts`, `ext/queue.test.ts`; statusline real 97–111 ms | ✓ ⏸ | Proxy es excepción documentada (CP-035.5) |
| RNF-09 | CP-027, CP-050 | AUTO | `daemon/tailer.test.ts`, `desktop/view.test.ts`, `ext/panelView.test.ts`, `ext/badge.test.ts` | ◐ | Versión desconocida / campos faltantes no pasan a `error` |
| RNF-10 | CP-001, CP-003, CP-030, CP-033, CP-034 | AUTO | `core/parsers/*.test.ts`, `verify/no-native.mjs`, `scripts/test/*` | ◐ | `typecheck`/`build` ✓; `scripts/test` fuera de `npm test` y 1 test rojo (D-20); fixtures reales sin commitear (D-7) |
| RNF-11 | CP-002, CP-035 | AUTO | `scripts/with-ca.mjs`, `daemon/proxy-providers.test.ts` (`HTTPS_PROXY`) | ✓ | Daemon real `extraCa=true` |
| RNF-12 | CP-035, CP-038, CP-041, CP-058 | AUTO | `daemon/proxy.test.ts`, `ext/fetchWrapper.test.ts`, `ext/handoff.test.ts`, `ext/banner.test.ts`, `verify/no-autosend.mjs` | ✓ | |
| RNF-13 | CP-009, CP-048, CP-051 | AUTO (parte) | `core/engine.test.ts`, `core/fixes1.test.ts`, `desktop/store.test.ts`, `ext/banner.test.ts` | ✓ | Replay real 0,43 sugerencias/h activa; aceptación > 40 % se mide en uso |
| RNF-14 | CP-021, CP-051, CP-052 | AUTO (parte) | `core/savings.test.ts`, `desktop/stats-csv.test.ts`, `daemon/handoff.test.ts` | ✓ | Umbral < 2 % se observa en uso |

## Superficies de UI (SPEC §9) y criterios de fase (SPEC §10)

| Ítem | Historias | Tests / evidencia | Estado |
| --- | --- | --- | --- |
| Statusline | CP-045 | `daemon/fixes1.test.ts`, `daemon/planUsage.test.ts`, `daemon/hooks.test.ts`, instalación real | ✓ (el `⏳ límite` depende de D-19/D-22) |
| Tray + overlay | CP-046 | `desktop/store.test.ts`, `desktop/view.test.ts`, `desktop/notify-actions.test.ts`, `desktop/account-overlay.test.ts`, smoke | ✓ ⏸ |
| Notificación | CP-047 | `desktop/notify-actions.test.ts` | ✓ ⏸ |
| Banner | CP-048 | `ext/banner.test.ts` | ◐ ⏸ |
| Side panel, badge | CP-049 | `ext/panelView.test.ts`, `ext/badge.test.ts` | ◐ ⏸ |
| Dashboard | CP-050, CP-051 | `desktop/misc.test.ts`, `desktop/stats-csv.test.ts`, smoke | ◐ ⏸ |
| F0: eventos de 3 CLIs y 3 sitios | CP-031, CP-033, CP-034, CP-038, CP-039 | Claude Code real; Codex/Gemini instalados sin login; web sin sesión real | ✗ ⏸ |
| F0: tokens CLI = `usage` ±0 % | CP-030 | `verify/real-transcripts-usage.ts` | ✓ |
| F0: estimación web ±15 % | CP-005 | `verify/estimator-abs.ts` | ◐ |
| F0: sugerencia < 1 s | CP-024 | `daemon/pipeline.test.ts`, `daemon/fixes1.test.ts` | ✓ |
| F0: cero pedidos modificados | CP-058 | `daemon/proxy.test.ts`, `ext/fetchWrapper.test.ts`, `verify/no-autosend.mjs` | ✓ |
| F1: proxy < 5 ms | CP-035 | `daemon/proxy.test.ts` | ✓ |
| F1: proyección < 20 % error en 5 h | CP-018 | `core/projection.test.ts` (sintético ✓), `eval-projection.ts` (real: 1 h 26,8 %) | ◐ |
| F1: informe de spike | CP-042 | `docs/SPIKE-desktop.md`, `docs/SPIKE-desktop-traffic.md` | ✓ |
| F2: R4 precisión > 80 % / 100 casos | CP-019 | `core/r4.dataset.test.ts` | ✓ (sintético) |
| F2: desktop health verde 5 días | CP-043 (MANUAL) | — | ✗ bloqueado (H-1) |
| F3: nada de contenido ni hashes sale; aprobación de seguridad | CP-057 | `core/team.test.ts`, `daemon/routes.test.ts`, `scripts/test/team-export.test.ts` | ✓ AUTO · ⏸ aprobación (H-3) |

## Huecos detectados

- **Requerimientos sin historia:** ninguno.
- **Historias sin requerimiento directo:** CP-001, CP-002, CP-003 (fundaciones; trazan a RNF-10/RNF-11).
- **Historias sin test automatizado propio:** CP-042 y CP-044 (MANUAL por diseño). CP-002 se verifica por comando.
- **Tests fuera de `npm test`:** los 31 de `scripts/test/**` (D-20; 1 rojo).
- **Criterios implementados pero sin test:** CP-018.4 (rama USD de R10), CP-037.2 (`chrome.*` del SW), CP-049.2 (toggles), CP-050.2 (panel de salud).
- **Criterios sin implementación:** CP-019.4 (`transformers.js`, H-8), CP-027.3 / CP-030.5 (versión desconocida / campos faltantes → `error`), CP-016.1 (`tier` configurable).
- **Criterio que pasa en test y falla en producción:** CP-018.2 (D-19).
- **Scripts de verificación de la aceptación:** `verify/no-native.mjs` (CP-001.3), `verify/no-autosend.mjs` (CP-058.2), `verify/real-transcripts-usage.ts` (CP-030.4/.6), `verify/estimator-abs.ts` (CP-005.3), **ronda 2:** `verify/r10-replay-cooldown.ts` (CP-018.2, D-19) (`verify/vitest.scripts.config.ts` se eliminó: con D-20 el `vitest.config.ts` raíz corre `scripts/test/**`).
- **Bloqueos de entorno / humanos:** login de Codex y Gemini (CP-033.5, CP-034.5); Claude Desktop rechaza CDP (CP-043, H-1); ChatGPT Desktop no instalado (CP-044); extensión sin aprobación IT (H-4).
