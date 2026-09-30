# Trazabilidad — requerimiento → historias → tests

Fuente: [SPEC.md](SPEC.md) · [BACKLOG.md](BACKLOG.md). Actualizado: 2026-09-30.
Columna **Tests / archivos**: se completa al entregar cada historia (ruta del test vitest o script `scripts/verify/*`). Hoy no existe código: todas las filas están en `pendiente`.
Columna **Verificación**: AUTO = verificable en esta máquina por test; MANUAL = requiere sesión real / app / humano; MIXTA = ambas.

## Requerimientos funcionales

| Req | Fase | Historias | Verificación | Tests / archivos | Notas |
| --- | --- | --- | --- | --- | --- |
| RF-CAP-01 | 0 | CP-030, CP-031 | AUTO | pendiente | Se verifica también contra todos los transcripts reales (CP-030.6) |
| RF-CAP-02 | 0 | CP-032 | AUTO | pendiente | |
| RF-CAP-03 | 0 | CP-033 | MIXTA | pendiente | Sólo fixtures sintéticos; verificación real bloqueada hasta instalar Codex |
| RF-CAP-04 | 0 | CP-034 | MIXTA | pendiente | Sólo fixtures sintéticos; verificación real bloqueada hasta instalar Gemini CLI |
| RF-CAP-05 | 0 | CP-038 | MIXTA | pendiente | Fixtures SSE deben grabarse en sesión real (MANUAL una vez) |
| RF-CAP-06 | 0 | CP-039 | MIXTA | pendiente | Idem, fixture HTML real |
| RF-CAP-07 | 0 | CP-040 | MIXTA | pendiente | |
| RF-CAP-08 | 1 | CP-035, CP-036 | AUTO (+1 MANUAL) | pendiente | |
| RF-CAP-09 | 2 | CP-042, CP-043 | MIXTA | pendiente | Criterio «health verde 5 días» sólo MANUAL |
| RF-CAP-10 | 2 | CP-042, CP-044 | MANUAL | pendiente | Depende del spike; puede cerrarse `won't` |
| RF-NOR-01 | 0 | CP-003, CP-004, CP-030, CP-033, CP-034, CP-036 | AUTO | pendiente | |
| RF-NOR-02 | 0 | CP-005, CP-030, CP-038 | AUTO | pendiente | |
| RF-NOR-03 | 0 | CP-005, CP-038 | AUTO | pendiente | ±15 % calibrado contra `output_tokens` de Claude Code; sin verdad de terreno para Gemini web |
| RF-EST-01 | 0 | CP-007, CP-023, CP-025, CP-045, CP-049 | AUTO | pendiente | |
| RF-EST-02 | 1 | CP-018, CP-055 | AUTO | pendiente | |
| RF-REG-01 | 0 | CP-008, CP-024 | AUTO | pendiente | |
| RF-REG-02 | 0 | CP-008, CP-054 | AUTO | pendiente | |
| RF-REG-03 | 0 | CP-009 | AUTO | pendiente | |
| RF-REG-04 | 1 | CP-014 | AUTO | pendiente | |
| RF-REG-05 | 2 | CP-019 | AUTO | pendiente | Requiere dataset de 100 casos etiquetados (`fixtures/r4/`) |
| RF-SUG-01 | 0 | CP-026, CP-037, CP-046 | AUTO | pendiente | |
| RF-SUG-02 | 0 | CP-004, CP-046, CP-048 | AUTO | pendiente | |
| RF-SUG-03 | 0 | CP-023, CP-026, CP-046 | AUTO | pendiente | |
| RF-HAN-01 | 0 | CP-052 | MIXTA | pendiente | Calidad del resumen sólo MANUAL |
| RF-HAN-02 | 0 | CP-041 | MIXTA | pendiente | |
| RF-HAN-03 | 0 | CP-046, CP-053 | AUTO | pendiente | |
| RF-DSH-01 | 1 | CP-050 | MIXTA | pendiente | |
| RF-DSH-02 | 1 | CP-021, CP-051 | MIXTA | pendiente | |
| RF-CFG-01 | 1 | CP-055 | AUTO | pendiente | Límites de suscripción no publicados: presets «a calibrar» |
| RF-CFG-02 | 0 | CP-049, CP-054 | AUTO | pendiente | |
| RF-CFG-03 | 2 | CP-056 | AUTO | pendiente | |
| RF-TEAM-01 | 3 | CP-057 | MIXTA | pendiente | `done` requiere aprobación de seguridad humana |

## Catálogo de reglas

| Regla | Fase | Historias | Verificación | Tests / archivos | Notas |
| --- | --- | --- | --- | --- | --- |
| R1 | 0 | CP-010 | AUTO | pendiente | |
| R2 | 0 | CP-011 | AUTO | pendiente | TTL real desde `ephemeral_1h/5m` |
| R3 | 1 | CP-015 | AUTO | pendiente | |
| R4 | 2 | CP-019 | AUTO | pendiente | |
| R5 | 0 | CP-010 | AUTO | pendiente | |
| R6 | 1 | CP-015 | AUTO | pendiente | Definiciones de herramientas: proxy (exacto) y Claude Code vía config MCP + adjuntos de herramientas (ver DECISIONS) |
| R7 | 1 | CP-016 | AUTO | pendiente | |
| R8 | 0 | CP-012, CP-047 | AUTO (+ notificación MANUAL) | pendiente | |
| R9 | 1 | CP-017 | AUTO | pendiente | |
| R10 | 1 | CP-018, CP-047 | AUTO | pendiente | |
| W1 | 0 | CP-013, CP-048 | AUTO | pendiente | Umbral 80 k a calibrar (pregunta abierta SPEC §12) |
| W2 | 1 | CP-017, CP-040 | AUTO | pendiente | |
| W3 | 0 | CP-013, CP-040, CP-048 | AUTO | pendiente | |
| W4 | 1 | CP-016 | AUTO | pendiente | |
| G1 | 2 | CP-020 | AUTO | pendiente | |
| G2 | 2 | CP-020 | AUTO | pendiente | |

## Requerimientos no funcionales

| Req | Historias | Verificación | Tests / archivos | Notas |
| --- | --- | --- | --- | --- |
| RNF-01 | CP-006, CP-052, CP-054, CP-057 | AUTO | pendiente | Test de fuga sobre sql.js y exportaciones |
| RNF-02 | CP-006, CP-052 | AUTO | pendiente | |
| RNF-03 | CP-022, CP-032, CP-037 | AUTO | pendiente | |
| RNF-04 | CP-035 | AUTO | pendiente | |
| RNF-05 | CP-035 | AUTO | pendiente | Medido contra upstream simulado local; latencia real a Internet no aplica |
| RNF-06 | CP-024, CP-031 | AUTO | pendiente | |
| RNF-07 | CP-028 | AUTO | pendiente | Aplica al daemon; Electron (tray) se mide aparte, sin objetivo en SPEC |
| RNF-08 | CP-029, CP-037, CP-045 | MIXTA | pendiente | Proxy es excepción documentada (CP-035.5) |
| RNF-09 | CP-027, CP-050 | AUTO | pendiente | |
| RNF-10 | CP-001, CP-003, CP-030, CP-033, CP-034 | AUTO | pendiente | |
| RNF-11 | CP-002, CP-035 | AUTO | pendiente | |
| RNF-12 | CP-035, CP-038, CP-041, CP-058 | AUTO | pendiente | |
| RNF-13 | CP-009, CP-048, CP-051 | AUTO (parte) | pendiente | «Aceptación > 40 %» es métrica de resultado: se mide en uso, no en build |
| RNF-14 | CP-021, CP-051, CP-052 | AUTO (parte) | pendiente | Umbral < 2 % se observa en uso; build sólo verifica que se mide |

## Superficies de UI (SPEC §9) y criterios de fase (SPEC §10)

| Ítem | Historias |
| --- | --- |
| Statusline | CP-045 |
| Tray + overlay | CP-046 |
| Notificación | CP-047 |
| Banner | CP-048 |
| Side panel, badge | CP-049 |
| Dashboard | CP-050, CP-051 |
| F0: eventos de 3 CLIs y 3 sitios | CP-031, CP-033, CP-034, CP-038, CP-039 (Codex/Gemini CLI sólo fixtures) |
| F0: tokens CLI = `usage` ±0 % | CP-030 |
| F0: estimación web ±15 % | CP-005 |
| F0: sugerencia < 1 s | CP-024 |
| F0: cero pedidos modificados | CP-058 |
| F1: proxy < 5 ms | CP-035 |
| F1: proyección < 20 % error en 5 h | CP-018 |
| F1: informe de spike | CP-042 |
| F2: R4 precisión > 80 % / 100 casos | CP-019 |
| F2: desktop health verde 5 días | CP-043 (MANUAL) |
| F3: nada de contenido ni hashes sale; aprobación de seguridad | CP-057 |

## Huecos detectados

- **Requerimientos sin historia:** ninguno.
- **Historias sin requerimiento directo:** CP-001, CP-002, CP-003 (fundaciones; trazan a RNF-10/RNF-11).
- **Historias sin test (todas, hoy):** 58/58 — sin código aún. Esta tabla se actualiza en cada verificación de incremento.
- **Criterios sólo MANUAL:** CP-042, CP-044 completas; criterios MANUAL de CP-029, CP-033, CP-034, CP-035, CP-037..CP-041, CP-043, CP-045..CP-052, CP-057.
- **Bloqueos de entorno:** Codex y Gemini CLI no instalados (CP-033.5, CP-034.5); Claude Desktop / ChatGPT Desktop no verificados (CP-042).
