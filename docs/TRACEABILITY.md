# Trazabilidad — requerimiento → historias → tests

Fuente: [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md) · verificación: [ACCEPTANCE.md](ACCEPTANCE.md). Actualizado: 2026-09-30 (commit `5b805e3`).
Columna **Tests / archivos**: rutas abreviadas — `core/` = `packages/core/test/`, `daemon/` = `apps/daemon/test/`, `desktop/` = `apps/desktop/test/`, `ext/` = `apps/extension/test/`, `verify/` = `scripts/verify/`. Números de línea y estado por criterio en ACCEPTANCE.md §2.
Columna **Estado**: resultado de la verificación del requerimiento (✓ cumplido con evidencia · ◐ parcial · ✗ falta · ⏸ requiere paso MANUAL/humano).

## Requerimientos funcionales

| Req | Fase | Historias | Verificación | Tests / archivos | Estado | Notas |
| --- | --- | --- | --- | --- | --- | --- |
| RF-CAP-01 | 0 | CP-030, CP-031 | AUTO | `core/parsers/claudeCode.test.ts`, `daemon/tailer.test.ts`, `verify/real-transcripts-usage.ts` | ✓ | 316 transcripts reales, 0 excepciones, ±0 tokens |
| RF-CAP-02 | 0 | CP-032 | AUTO | `daemon/hooks.test.ts` | ✓ (⏸ instalación real) | Instalador probado en HOME temporal; decisión H-2 |
| RF-CAP-03 | 0 | CP-033 | MIXTA | `core/parsers/codex.test.ts`, `daemon/tailer.test.ts` | ◐ ⏸ | Sólo fixtures sintéticos; Codex no instalado |
| RF-CAP-04 | 0 | CP-034 | MIXTA | `core/parsers/geminiTelemetry.test.ts`, `daemon/tailer.test.ts` | ◐ ⏸ | Falta `install-gemini-telemetry.mjs`; Gemini CLI no instalado |
| RF-CAP-05 | 0 | CP-038 | MIXTA | `ext/fetchWrapper.test.ts`, `ext/controller.test.ts`, `ext/webFixtures.test.ts`, `core/parsers/web.test.ts` | ◐ ⏸ | Fixtures SSE sintéticos; falta sesión real |
| RF-CAP-06 | 0 | CP-039 | MIXTA | `ext/geminiDom.test.ts` | ◐ ⏸ | Fixture HTML sintético |
| RF-CAP-07 | 0 | CP-040 | MIXTA | `ext/controller.test.ts` | ◐ ⏸ | |
| RF-CAP-08 | 1 | CP-035, CP-036 | AUTO (+1 MANUAL) | `daemon/proxy.test.ts`, `core/parsers/sse.test.ts` | ◐ | Anthropic de punta a punta; OpenAI/Google sólo extractor |
| RF-CAP-09 | 2 | CP-042, CP-043 | MIXTA | `desktop/cdp.test.ts`, `desktop/misc.test.ts` (fuses), `docs/SPIKE-desktop.md` | ✗ bloqueado | CDP rechazado por Claude Desktop (H-1) |
| RF-CAP-10 | 2 | CP-042, CP-044 | MANUAL | `docs/SPIKE-desktop.md` | won't (provisorio) | ChatGPT Desktop no instalado |
| RF-NOR-01 | 0 | CP-003, CP-004, CP-030, CP-033, CP-034, CP-036 | AUTO | `core/validate.test.ts`, `core/parsers/*.test.ts`, `ext/turnEvent.test.ts` | ◐ | CP-003 (snapshot/replay) falta |
| RF-NOR-02 | 0 | CP-005, CP-030, CP-038 | AUTO | `core/parsers/claudeCode.test.ts`, `ext/turnEvent.test.ts`, `desktop/cdp.test.ts` | ✓ | |
| RF-NOR-03 | 0 | CP-005, CP-038 | AUTO | `core/misc.test.ts`, `verify/estimator-abs.ts`, `scripts/verify-estimator.ts` | ✓ (Anthropic) | Mediana \|err\| 4,8 %, p90 17,1 %; sin verdad de terreno web/Gemini |
| RF-EST-01 | 0 | CP-007, CP-023, CP-025, CP-045, CP-049 | AUTO | `core/state.test.ts`, `daemon/storage.test.ts`, `daemon/routes.test.ts`, `daemon/planUsage.test.ts`, `ext/badge.test.ts`, `ext/panelView.test.ts` | ◐ | Statusline «⚠ Para» (D-3) |
| RF-EST-02 | 1 | CP-018, CP-055 | AUTO | `core/rules.test.ts` (R10), `daemon/planUsage.test.ts`, `desktop/config-team.test.ts` | ✗ | Ritmo/proyección no expuestos; sin medición de error (D-5) |
| RF-REG-01 | 0 | CP-008, CP-024 | AUTO | `core/engine.test.ts`, `daemon/pipeline.test.ts` | ✓ | |
| RF-REG-02 | 0 | CP-008, CP-054 | AUTO | `core/engine.test.ts`, `daemon/routes.test.ts` | ✓ | |
| RF-REG-03 | 0 | CP-009 | AUTO | `core/engine.test.ts` | ✓ | |
| RF-REG-04 | 1 | CP-014 | AUTO | `core/engine.test.ts`, `daemon/pipeline.test.ts` | ✓ | |
| RF-REG-05 | 2 | CP-019 | AUTO | `core/misc.test.ts` (embed), `core/rules.test.ts` (R4) | ✗ | Sin dataset de 100 casos ni `transformers.js` (D-6) |
| RF-SUG-01 | 0 | CP-026, CP-037, CP-046 | AUTO | `daemon/pipeline.test.ts`, `daemon/routes.test.ts`, `desktop/store.test.ts` | ✓ | SW de la extensión sin test (CP-037.2) |
| RF-SUG-02 | 0 | CP-004, CP-046, CP-048 | AUTO | `core/validate.test.ts`, `core/engine.test.ts`, `desktop/notify-actions.test.ts`, `ext/banner.test.ts` | ✓ | |
| RF-SUG-03 | 0 | CP-023, CP-026, CP-046 | AUTO | `daemon/storage.test.ts`, `daemon/pipeline.test.ts`, `daemon/routes.test.ts` | ✓ | Ignorar/posponer del overlay sin test |
| RF-HAN-01 | 0 | CP-052 | MIXTA | `daemon/handoff.test.ts` | ✓ ⏸ | Calidad con `claude -p` real: MANUAL |
| RF-HAN-02 | 0 | CP-041 | MIXTA | `ext/handoff.test.ts` | ✓ ⏸ | |
| RF-HAN-03 | 0 | CP-046, CP-053 | AUTO | `desktop/notify-actions.test.ts`, `daemon/handoff.test.ts` | ◐ ⏸ | Test de portapapeles real gated (`CP_TEST_CLIPBOARD=1`) |
| RF-DSH-01 | 1 | CP-050 | MIXTA | `desktop/misc.test.ts` (timeline), `desktop/stats-csv.test.ts` (filtros) | ◐ ⏸ | Panel de salud sin test |
| RF-DSH-02 | 1 | CP-021, CP-051 | MIXTA | `core/savings.test.ts`, `desktop/stats-csv.test.ts`, `daemon/routes.test.ts` | ✓ ⏸ | |
| RF-CFG-01 | 1 | CP-055 | AUTO | `daemon/routes.test.ts`, `desktop/config-team.test.ts` | ◐ | Una sola ventana por perfil |
| RF-CFG-02 | 0 | CP-049, CP-054 | AUTO | `daemon/routes.test.ts`, `core/engine.test.ts`, `ext/panelView.test.ts` | ◐ | Config inválida → defaults, no última válida |
| RF-CFG-03 | 2 | CP-056 | AUTO | `daemon/routes.test.ts`, `desktop/config-team.test.ts` | ✓ | |
| RF-TEAM-01 | 3 | CP-057 | MIXTA | `core/team.test.ts`, `daemon/routes.test.ts`, `desktop/config-team.test.ts` | ◐ ⏸ | Falta `team-export.mjs`; aprobación de seguridad (H-3) |

## Catálogo de reglas

| Regla | Fase | Historias | Verificación | Tests / archivos | Estado | Notas |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | 0 | CP-010 | AUTO | `core/rules.test.ts`, `core/engine.test.ts`, `daemon/pipeline.test.ts` | ◐ | `info` < 80 %, sin foco (D-2); tapada por R10 (D-1) |
| R2 | 0 | CP-011 | AUTO | `core/rules.test.ts`, `daemon/pipeline.test.ts` (temporizador) | ✓ | La más ruidosa en replay real (D-18) |
| R3 | 1 | CP-015 | AUTO | `core/rules.test.ts` | ◐ | Sin hash de system prompt |
| R4 | 2 | CP-019 | AUTO | `core/rules.test.ts`, `core/misc.test.ts` | ✗ | Sin dataset; falta acción `handoff` |
| R5 | 0 | CP-010 | AUTO | `core/rules.test.ts`, `core/engine.test.ts` | ◐ | Acción genérica, no por herramienta |
| R6 | 1 | CP-015 | AUTO | `core/rules.test.ts` | ✗ | Inalcanzable en producción (D-4) |
| R7 | 1 | CP-016 | AUTO | `core/rules.test.ts` | ◐ | `tier` no configurable |
| R8 | 0 | CP-012, CP-047 | AUTO (+ notificación MANUAL) | `core/rules.test.ts`, `core/parsers/codex.test.ts`, `desktop/notify-actions.test.ts` | ◐ ⏸ | Detalle sin comando/timestamps |
| R9 | 1 | CP-017 | AUTO | `core/rules.test.ts`, `core/misc.test.ts` (splitBlocks) | ✓ | |
| R10 | 1 | CP-018, CP-047 | AUTO | `core/rules.test.ts`, `daemon/planUsage.test.ts` | ◐ | Por sesión; `critical` casi nunca (D-1, D-5) |
| W1 | 0 | CP-013, CP-048 | AUTO | `core/rules.test.ts`, `ext/banner.test.ts` | ✓ | Umbral 80k sin calibrar |
| W2 | 1 | CP-017, CP-040 | AUTO | `core/rules.test.ts`, `ext/controller.test.ts` | ◐ | Sólo misma conversación (D-11) |
| W3 | 0 | CP-013, CP-040, CP-048 | AUTO | `core/rules.test.ts`, `ext/controller.test.ts`, `ext/fetchWrapper.test.ts` | ✓ | |
| W4 | 1 | CP-016 | AUTO | `core/rules.test.ts`, `ext/fetchWrapper.test.ts`, `ext/turnEvent.test.ts` | ✓ | |
| G1 | 2 | CP-020 | AUTO | `core/rules.test.ts` | ✓ | |
| G2 | 2 | CP-020 | AUTO | `core/rules.test.ts` | ✓ | |

## Requerimientos no funcionales

| Req | Historias | Verificación | Tests / archivos | Estado | Notas |
| --- | --- | --- | --- | --- | --- |
| RNF-01 | CP-006, CP-052, CP-054, CP-057 | AUTO | `daemon/storage.test.ts`, `daemon/pipeline.test.ts`, `daemon/handoff.test.ts`, `core/team.test.ts`, `ext/turnEvent.test.ts`, `desktop/cdp.test.ts` | ✓ | Test de fuga sobre `cp.db` y exportaciones |
| RNF-02 | CP-006, CP-052 | AUTO | `core/misc.test.ts`, `daemon/handoff.test.ts`, `ext/handoff.test.ts` | ✓ | |
| RNF-03 | CP-022, CP-032, CP-037 | AUTO | `daemon/routes.test.ts`, `daemon/hooks.test.ts` | ◐ | Cualquier `chrome-extension://*` aceptado (D-9) |
| RNF-04 | CP-035 | AUTO | `daemon/proxy.test.ts` | ◐ | Sólo `x-api-key` probado |
| RNF-05 | CP-035 | AUTO | `daemon/proxy.test.ts` | ✓ | Primer byte p95 1,7–2,6 ms; por chunk +0,4–0,9 ms (upstream local) |
| RNF-06 | CP-024, CP-031 | AUTO | `daemon/pipeline.test.ts`, `daemon/tailer.test.ts`; live append→WS p95 39 ms | ✓ | |
| RNF-07 | CP-028 | AUTO | `verify/idle.mjs --minutes 10` | ✓ | RSS máx 90,3 MB, CPU 0,4 % |
| RNF-08 | CP-029, CP-037, CP-045 | MIXTA | `daemon/hooks.test.ts`, `ext/queue.test.ts`; live hook/statusline 63–79 ms | ✓ ⏸ | Proxy es excepción documentada (CP-035.5) |
| RNF-09 | CP-027, CP-050 | AUTO | `daemon/tailer.test.ts`, `desktop/view.test.ts`, `ext/panelView.test.ts`, `ext/badge.test.ts` | ◐ | Versión desconocida no pasa a `error` |
| RNF-10 | CP-001, CP-003, CP-030, CP-033, CP-034 | AUTO | `core/parsers/*.test.ts`, `verify/no-native.mjs` | ◐ | Sin snapshot/replay (CP-003); `npm run typecheck` roto |
| RNF-11 | CP-002, CP-035 | AUTO | `scripts/with-ca.mjs` (comando), live `extraCa=true` | ✓ | `HTTPS_PROXY` sin test |
| RNF-12 | CP-035, CP-038, CP-041, CP-058 | AUTO | `daemon/proxy.test.ts`, `ext/fetchWrapper.test.ts`, `ext/handoff.test.ts`, `ext/banner.test.ts`, `verify/no-autosend.mjs` | ✓ | |
| RNF-13 | CP-009, CP-048, CP-051 | AUTO (parte) | `core/engine.test.ts`, `desktop/store.test.ts`, `ext/banner.test.ts` | ◐ | «Una visible» cumple, pero R10 monopoliza el lugar (D-1); aceptación > 40 % se mide en uso |
| RNF-14 | CP-021, CP-051, CP-052 | AUTO (parte) | `core/savings.test.ts`, `desktop/stats-csv.test.ts`, `daemon/handoff.test.ts` | ✓ | Umbral < 2 % se observa en uso |

## Superficies de UI (SPEC §9) y criterios de fase (SPEC §10)

| Ítem | Historias | Tests / evidencia | Estado |
| --- | --- | --- | --- |
| Statusline | CP-045 | `daemon/planUsage.test.ts`, `daemon/hooks.test.ts`, live | ◐ (D-3) ⏸ |
| Tray + overlay | CP-046 | `desktop/store.test.ts`, `desktop/view.test.ts`, `desktop/notify-actions.test.ts`, smoke | ◐ ⏸ |
| Notificación | CP-047 | `desktop/notify-actions.test.ts` | ✓ ⏸ |
| Banner | CP-048 | `ext/banner.test.ts` | ◐ ⏸ |
| Side panel, badge | CP-049 | `ext/panelView.test.ts`, `ext/badge.test.ts` | ◐ ⏸ |
| Dashboard | CP-050, CP-051 | `desktop/misc.test.ts`, `desktop/stats-csv.test.ts`, smoke | ◐ ⏸ |
| F0: eventos de 3 CLIs y 3 sitios | CP-031, CP-033, CP-034, CP-038, CP-039 | Claude Code real; resto fixtures sintéticos | ✗ ⏸ |
| F0: tokens CLI = `usage` ±0 % | CP-030 | `verify/real-transcripts-usage.ts` | ✓ |
| F0: estimación web ±15 % | CP-005 | `verify/estimator-abs.ts` | ◐ |
| F0: sugerencia < 1 s | CP-024 | `daemon/pipeline.test.ts`, live | ✓ |
| F0: cero pedidos modificados | CP-058 | `daemon/proxy.test.ts`, `ext/fetchWrapper.test.ts`, `verify/no-autosend.mjs` | ✓ |
| F1: proxy < 5 ms | CP-035 | `daemon/proxy.test.ts` | ✓ |
| F1: proyección < 20 % error en 5 h | CP-018 | — | ✗ |
| F1: informe de spike | CP-042 | `docs/SPIKE-desktop.md` | ✓ |
| F2: R4 precisión > 80 % / 100 casos | CP-019 | — | ✗ |
| F2: desktop health verde 5 días | CP-043 (MANUAL) | — | ✗ bloqueado (H-1) |
| F3: nada de contenido ni hashes sale; aprobación de seguridad | CP-057 | `core/team.test.ts`, `daemon/routes.test.ts` | ✓ AUTO · ⏸ aprobación (H-3) |

## Huecos detectados

- **Requerimientos sin historia:** ninguno.
- **Historias sin requerimiento directo:** CP-001, CP-002, CP-003 (fundaciones; trazan a RNF-10/RNF-11).
- **Historias sin test automatizado propio:** CP-042 y CP-044 (MANUAL por diseño; CP-042 tiene test del parser de fuses). CP-002 se verifica por comando, no por test.
- **Criterios implementados pero sin test:** CP-007.4, CP-018.4, CP-027.3 (versión), CP-030.5 (campos faltantes), CP-035.3/.4, CP-036.2, CP-037.2, CP-043.2, CP-046.2 (ignorar/posponer), CP-049.2 (toggles), CP-050.2.
- **Criterios sin implementación:** CP-003.1/.2, CP-010.3, CP-015.3 (en producción), CP-018.1/.3, CP-019.2/.4, CP-034.3.
- **Scripts de verificación agregados en la aceptación:** `scripts/verify/no-native.mjs` (CP-001.3), `scripts/verify/no-autosend.mjs` (CP-058.2), `scripts/verify/real-transcripts-usage.ts` (CP-030.4/.6), `scripts/verify/estimator-abs.ts` (CP-005.3).
- **Bloqueos de entorno:** Codex y Gemini CLI no instalados (CP-033.5, CP-034.5); Claude Desktop rechaza CDP (CP-043); ChatGPT Desktop no instalado (CP-044).
