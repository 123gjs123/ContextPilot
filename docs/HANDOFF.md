# Traspaso — ContextPilot (2026-09-30)

Estado para retomar. Detalle en `docs/ACCEPTANCE.md` (ronda 2), `docs/BACKLOG.md`, `docs/DECISIONS.md`, `docs/reports/*`.

## Dónde estamos

- Fases 0–3 implementadas; 507 tests verdes (`npx vitest run`), `npm run typecheck` y `npm run build` limpios.
- Aceptación ronda 2 del agente `product`: 174/208 criterios PASS. Después se corrigieron D-19..D-23 y se sumó la UI «En vivo» (CP-059..065). **Falta la ronda 3 de aceptación.**
- Hooks y statusline instalados en `~/.claude/settings.json` (backup `settings.json.cp-bak`; desinstalar con `node scripts/install-hooks.mjs --uninstall`).
- Codex CLI 0.159.2 y Gemini CLI 0.62.0 instalados globalmente, sin login.

## Cómo levantarlo

```powershell
cd C:\Users\fosh\contextpilot
node scripts/with-ca.mjs npm run start -w @contextpilot/daemon      # daemon en 127.0.0.1:47800
npm run start -w @contextpilot/desktop -- --dashboard               # monitor (tray + dashboard)
```

Sin daemon, hooks y statusline salen en silencio («ContextPilot: sin datos»).

## Pendiente del usuario

1. Login en `codex` y `gemini`; luego `node scripts/install-gemini-telemetry.mjs` y una sesión corta en cada uno (cierra «3 CLIs» de fase 0).
2. Cargar la extensión: `apps/extension/dist` como descomprimida en Chrome/Edge; pegar el token de `%LOCALAPPDATA%\ContextPilot\token`; checklist en `docs/ACCEPTANCE.md` §6.
3. H-1 Claude Desktop: autorizar el adaptador que lee su IndexedDB local (`docs/SPIKE-desktop-traffic.md`) — fue bloqueado por el clasificador de permisos — o cerrar CP-043 como won't.
4. H-3 aprobación de seguridad del modo equipo; H-5 exigir id de extensión; H-8 diferir `transformers.js` (recomendado).
5. Decidir si daemon y monitor arrancan con Windows (hoy se levantan a mano).

## Próximos pasos técnicos

- Ronda 3 de aceptación con el agente `product` (ver `.claude/agents/product.md`).
- D-7: escribir fixtures reales con `node scripts/snapshot-fixtures.mjs --write` y revisarlos antes de commitear.
- D-16 restante: tests de service worker, toggles del panel y panel de salud.
- Proyección R10: error a 1 h 17,8 % en holdout con pocos datos; recalibrar con más ventanas reales.
