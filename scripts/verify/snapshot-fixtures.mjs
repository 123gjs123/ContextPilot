#!/usr/bin/env node
// CP-003.1: alias en la ruta que cita el backlog. Mismo comportamiento y opciones que
// scripts/snapshot-fixtures.mjs (dry-run por defecto; escribe sólo con --write).
import { main } from '../snapshot-fixtures.mjs';

await main();
