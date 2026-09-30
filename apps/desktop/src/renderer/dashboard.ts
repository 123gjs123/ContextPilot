import { fmtPct, fmtTokens, type Config } from '@contextpilot/core';
import {
  configToForm,
  diffConfig,
  formToConfig,
  looksLikeConfig,
  PLAN_PRESETS,
  PROVIDER_LABEL,
  type ConfigForm,
  type PlanForm,
} from '../shared/configForm.js';
import { suggestionsCsv } from '../shared/csv.js';
import { distinct, filterSessions, statsQuery, statsView, type SessionFilter } from '../shared/stats.js';
import { mergeTeam, parseTeamFile, type TeamFile } from '../shared/team.js';
import { timelineModel, timelineSvg } from '../shared/timeline.js';
import type { AdapterHealth, AppSnapshot, SessionDetail, SessionView, Stats } from '../shared/types.js';
import { clear, cp, h, toast } from './dom.js';

// Dashboard (CP-050, CP-051, CP-055 UI, CP-056 UI, CP-057 UI). Sin framework: render por pestaña.

type Tab = 'sessions' | 'stats' | 'settings' | 'team';

const ui = {
  tab: 'sessions' as Tab,
  filter: {} as SessionFilter,
  sessions: [] as SessionView[],
  selected: undefined as string | undefined,
  detail: undefined as SessionDetail | undefined,
  snapshot: undefined as AppSnapshot | undefined,
  config: undefined as Config | undefined,
  form: undefined as ConfigForm | undefined,
  formErrors: {} as Record<string, string>,
  importCandidate: undefined as { name: string; config: Partial<Config> } | undefined,
  team: [] as TeamFile[],
};

const FEEDBACK_TEXT: Record<string, string> = { accepted: 'aceptada', dismissed: 'ignorada', snoozed: 'pospuesta', expired: 'vencida' };

const main = () => document.getElementById('main')!;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function api<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<T | undefined> {
  const r = await cp().api<T>(method, path, body);
  if (!r.ok) {
    toast(`${method} ${path.split('?')[0]}: ${r.error ?? r.status}`, true);
    return undefined;
  }
  return r.data;
}

// ---------------------------------------------------------------- Sesiones (CP-050)

async function loadSessions(): Promise<void> {
  const list = await api<SessionView[]>('GET', '/sessions');
  ui.sessions = Array.isArray(list) ? list : [];
  if (ui.selected) await loadDetail(ui.selected);
  render();
}

async function loadDetail(id: string): Promise<void> {
  ui.selected = id;
  ui.detail = await api<SessionDetail>('GET', `/sessions/${encodeURIComponent(id)}`);
  render();
}

function filtersBar(withSessionFilters: boolean): HTMLElement {
  const f = ui.filter;
  const set = (k: keyof SessionFilter) => (e: Event) => {
    const v = (e.target as HTMLInputElement).value;
    f[k] = v || undefined;
    ui.tab === 'stats' ? void renderStats() : render();
  };
  const providers = distinct(ui.sessions.map((s) => s.provider));
  const sources = distinct(ui.sessions.map((s) => s.source));
  return h(
    'div',
    { class: 'filters' },
    withSessionFilters &&
      h('label', {}, 'Proveedor ', h('select', { onchange: set('provider') }, h('option', { value: '' }, 'Todos'),
        providers.map((p) => h('option', { value: p, selected: f.provider === p }, p)))),
    withSessionFilters &&
      h('label', {}, 'Fuente ', h('select', { onchange: set('source') }, h('option', { value: '' }, 'Todas'),
        sources.map((s) => h('option', { value: s, selected: f.source === s }, s)))),
    h('label', {}, 'Desde ', h('input', { type: 'date', value: f.from ?? '', onchange: set('from') })),
    h('label', {}, 'Hasta ', h('input', { type: 'date', value: f.to ?? '', max: today(), onchange: set('to') })),
    h('button', { onclick: () => (ui.tab === 'stats' ? void renderStats() : void loadSessions()) }, 'Actualizar'),
    withSessionFilters && h('button', { onclick: () => void exportCsv() }, 'Exportar CSV'),
  );
}

async function exportCsv(): Promise<void> {
  const list = filterSessions(ui.sessions, ui.filter).slice(0, 300);
  const items: { session: SessionView; suggestions: SessionDetail['suggestions'] }[] = [];
  for (const s of list) {
    const d = await api<SessionDetail>('GET', `/sessions/${encodeURIComponent(s.sessionId)}`);
    if (d) items.push({ session: s, suggestions: d.suggestions ?? [] });
  }
  const r = await cp().saveFile(`contextpilot-sugerencias-${today()}.csv`, suggestionsCsv(items));
  if (r.ok) toast(`CSV guardado en ${r.path}`);
}

function healthCard(health: AdapterHealth[], snap?: AppSnapshot): HTMLElement {
  const rows = health.map((a) =>
    h('tr', {},
      h('td', {}, a.name),
      h('td', {}, h('span', { class: `status-dot status-${a.status}` }, a.status === 'ok' ? 'ok' : a.status === 'disabled' ? 'deshabilitado' : 'sin datos')),
      h('td', {}, a.lastEventAt ? new Date(a.lastEventAt).toLocaleString('es-AR') : '—'),
      h('td', { class: 'secondary' }, [a.detail ?? '', a.formatVersion ? ` · formato ${a.formatVersion}` : ''].join('')),
    ),
  );
  if (snap) {
    rows.push(
      h('tr', {},
        h('td', {}, 'claude-desktop (CDP, local)'),
        h('td', {}, h('span', { class: `status-dot status-${snap.desktopAdapter.status}` }, snap.desktopAdapter.status === 'ok' ? 'ok' : snap.desktopAdapter.status === 'disabled' ? 'apagado' : 'sin datos')),
        h('td', {}, '—'),
        h('td', { class: 'secondary' }, snap.desktopAdapter.detail),
      ),
    );
  }
  return h('div', { class: 'card' },
    h('h2', {}, 'Salud de adaptadores'),
    rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Adaptador'), h('th', {}, 'Estado'), h('th', {}, 'Último evento'), h('th', {}, 'Detalle'))), h('tbody', {}, rows))
      : h('div', { class: 'muted' }, 'sin datos'),
  );
}

function renderSessions(root: HTMLElement): void {
  root.append(filtersBar(true));
  const list = filterSessions(ui.sessions, ui.filter);
  const table = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Sesión'), h('th', {}, 'Modelo'), h('th', { class: 'num' }, 'Contexto'), h('th', {}, 'Último turno'))),
    h('tbody', {}, list.map((s) =>
      h('tr', { class: `click${s.sessionId === ui.selected ? ' sel' : ''}`, onclick: () => void loadDetail(s.sessionId) },
        h('td', { title: s.sessionId }, `${s.client || s.source} · ${s.sessionId.split(':').pop()!.slice(0, 8)}`),
        h('td', { class: 'secondary' }, s.model),
        h('td', { class: 'num' }, s.contextWindow ? `${s.estimated ? '≈' : ''}${fmtPct(s.contextPct)}` : 'sin datos'),
        h('td', { class: 'secondary' }, new Date(s.lastTurnAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })),
      ))),
  );
  const left = h('div', { class: 'card' }, h('h2', {}, `Sesiones (${list.length})`), list.length ? table : h('div', { class: 'muted' }, ui.snapshot?.connection === 'connected' ? 'Sin sesiones para estos filtros' : 'sin datos (daemon no disponible)'));

  const right = h('div', { class: 'card' });
  const d = ui.detail;
  if (!d || d.view.sessionId !== ui.selected) {
    right.append(h('h2', {}, 'Timeline'), h('div', { class: 'muted' }, 'Elegí una sesión para ver su timeline.'));
  } else {
    const model = timelineModel(d.timeline ?? [], d.view.contextWindow, d.suggestions ?? []);
    const chart = h('div', {});
    chart.innerHTML = timelineSvg(model); // SVG generado con escapeXml en timeline.ts
    right.append(
      h('h2', {}, `Timeline · ${d.view.client} · ${d.view.model}`),
      h('div', { class: 'legend' },
        h('span', {}, h('span', { class: 'sw s1' }), `Contexto (% de ${fmtTokens(d.view.contextWindow)})${d.view.estimated ? ' ≈' : ''}`),
        h('span', {}, h('span', { class: 'sw s2' }), 'Proporción de caché'),
        h('span', {}, '│ Sugerencias: ✓ aceptada · ✕ ignorada · ⏸ pospuesta · ! sin respuesta'),
      ),
      chart,
      h('h2', { style: 'margin-top:12px' }, 'Sugerencias'),
      (d.suggestions ?? []).length
        ? h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Hora'), h('th', {}, 'Regla'), h('th', {}, 'Severidad'), h('th', {}, 'Título'), h('th', {}, 'Feedback'), h('th', { class: 'num' }, 'Ahorro ≈'))),
            h('tbody', {}, d.suggestions.map((s) =>
              h('tr', {},
                h('td', {}, s.createdAt ? new Date(s.createdAt).toLocaleTimeString('es-AR', { timeStyle: 'short' }) : '—'),
                h('td', {}, s.ruleId), h('td', {}, s.severity), h('td', {}, s.title),
                h('td', {}, FEEDBACK_TEXT[s.feedback ?? ''] ?? '—'),
                h('td', { class: 'num' }, s.estimatedSavingTokens ? fmtTokens(s.estimatedSavingTokens) : '—'),
              ))))
        : h('div', { class: 'muted' }, 'Sin sugerencias en esta sesión'),
    );
  }
  root.append(h('div', { class: 'grid2' }, left, right));
  root.append(healthCard(ui.snapshot?.health ?? [], ui.snapshot));
}

// ---------------------------------------------------------------- Estadísticas (CP-051)

async function renderStats(): Promise<void> {
  const root = main();
  clear(root);
  root.append(filtersBar(false));
  const st = await api<Stats>('GET', `/stats${statsQuery(ui.filter)}`);
  if (ui.tab !== 'stats') return;
  if (!st) {
    root.append(h('div', { class: 'card muted' }, 'sin datos'));
    return;
  }
  const v = statsView(st);
  root.append(h('div', { class: 'kpis' }, v.kpis.map((k) =>
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, k.label), h('div', { class: `v ${k.status === 'bad' ? 'bad' : ''}` }, k.value),
      h('div', { class: 't' }, h('span', { class: `pill ${k.status}` }, `objetivo ${k.target}`))))));
  const bar = (val: number, max: number) => h('div', { class: 'bar', style: `width:${max ? Math.max(1, (val / max) * 100) : 0}%`, title: fmtTokens(val) });
  root.append(
    h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'Ahorro y aceptación por regla (más disparadas primero)'),
      v.rules.length ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Regla'), h('th', { class: 'num' }, 'Disparos'), h('th', { class: 'num' }, 'Aceptadas'), h('th', { class: 'num' }, 'Ignoradas'), h('th', { class: 'num' }, 'Pospuestas'), h('th', { class: 'num' }, 'Aceptación'), h('th', { class: 'num' }, 'Ahorro'), h('th', { style: 'width:30%' }, ''))),
        h('tbody', {}, v.rules.map((r) => h('tr', {}, h('td', {}, r.ruleId), h('td', { class: 'num' }, r.fired), h('td', { class: 'num' }, r.accepted), h('td', { class: 'num' }, r.dismissed), h('td', { class: 'num' }, r.snoozed), h('td', { class: 'num' }, r.acceptanceText), h('td', { class: 'num' }, r.savedText), h('td', {}, bar(r.savedTokens, v.maxRuleSaved))))),
      ) : h('div', { class: 'muted' }, 'sin datos')),
    h('div', { class: 'card' }, h('h2', {}, 'Consumo y ahorro por proveedor'),
      v.providers.length ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Proveedor'), h('th', { class: 'num' }, 'Sesiones'), h('th', { class: 'num' }, 'Entrada'), h('th', { class: 'num' }, 'Salida'), h('th', { class: 'num' }, 'Caché'), h('th', { class: 'num' }, 'Ahorro'), h('th', { style: 'width:30%' }, ''))),
        h('tbody', {}, v.providers.map((p) => h('tr', {}, h('td', {}, p.provider), h('td', { class: 'num' }, p.sessions), h('td', { class: 'num' }, p.inputText), h('td', { class: 'num' }, p.outputText), h('td', { class: 'num' }, p.cacheText), h('td', { class: 'num' }, p.savedText), h('td', {}, bar(p.savedTokens, v.maxProviderSaved))))),
      ) : h('div', { class: 'muted' }, 'sin datos')),
    h('div', { class: 'muted' }, 'Cifras de ahorro estimadas (≈); sólo cuentan sugerencias aceptadas.'),
  );
}

// ---------------------------------------------------------------- Configuración (CP-054/055/056)

async function loadConfig(): Promise<void> {
  const c = await api<Config>('GET', '/config');
  ui.config = c;
  ui.form = c ? configToForm(c) : undefined;
  ui.formErrors = {};
  render();
}

function numInput(value: number | null, onChange: (v: number | null) => void, err?: string, step = 'any'): HTMLElement {
  return h('span', {},
    h('input', { type: 'number', step, min: 0, value: value ?? '', onchange: (e: Event) => {
      const t = (e.target as HTMLInputElement).value;
      onChange(t === '' ? null : Number(t));
    } }),
    err ? h('span', { class: 'err' }, ` ${err}`) : null,
  );
}

function planEditor(p: PlanForm): HTMLElement {
  const err = (k: string) => ui.formErrors[`plans.${p.provider}.${k}`];
  const presets = PLAN_PRESETS.filter((x) => x.plan.provider === p.provider);
  const fields =
    p.kind === 'api'
      ? [
          h('label', {}, 'Presupuesto diario USD ', numInput(p.dailyBudgetUsd, (v) => (p.dailyBudgetUsd = v), err('dailyBudgetUsd'))),
          h('label', {}, 'USD/M entrada ', numInput(p.pricePerMTokIn, (v) => (p.pricePerMTokIn = v), err('pricePerMTokIn'))),
          h('label', {}, 'USD/M salida ', numInput(p.pricePerMTokOut, (v) => (p.pricePerMTokOut = v), err('pricePerMTokOut'))),
        ]
      : p.kind === 'subscription'
        ? [
            h('label', {}, 'Ventana (horas) ', numInput(p.windowHours, (v) => (p.windowHours = v), err('windowHours'))),
            h('label', {}, 'Límite de tokens por ventana ', numInput(p.windowBudgetTokens, (v) => (p.windowBudgetTokens = v), err('windowBudgetTokens'), '1000')),
            h('span', { class: 'pill none' }, 'a calibrar'),
          ]
        : [h('span', { class: 'muted' }, 'Sin perfil: R10 no se evalúa y no se muestra proyección.')];
  return h('div', { class: 'form-row' },
    h('strong', { style: 'min-width:150px' }, PROVIDER_LABEL[p.provider]),
    h('select', { onchange: (e: Event) => { p.kind = (e.target as HTMLSelectElement).value as PlanForm['kind']; render(); } },
      h('option', { value: 'none', selected: p.kind === 'none' }, 'Sin perfil'),
      h('option', { value: 'api', selected: p.kind === 'api' }, 'API (USD)'),
      h('option', { value: 'subscription', selected: p.kind === 'subscription' }, 'Suscripción (ventana)'),
    ),
    fields,
    h('select', { onchange: (e: Event) => {
      const pr = PLAN_PRESETS.find((x) => x.id === (e.target as HTMLSelectElement).value);
      if (pr) Object.assign(p, structuredClone(pr.plan));
      render();
    } }, h('option', { value: '' }, 'Preset…'), presets.map((x) => h('option', { value: x.id }, `${x.label}${x.calibrate ? ' (a calibrar)' : ''}`))),
  );
}

async function saveConfig(): Promise<void> {
  if (!ui.form) return;
  const { patch, errors } = formToConfig(ui.form);
  ui.formErrors = errors;
  if (Object.keys(errors).length) {
    render();
    toast('Revisá los campos marcados', true);
    return;
  }
  const c = await api<Config>('PUT', '/config', patch);
  if (c) {
    ui.config = c;
    ui.form = configToForm(c);
    toast('Configuración guardada y aplicada');
    render();
  }
}

async function exportConfig(): Promise<void> {
  const c = await api<unknown>('GET', '/config/export');
  if (!c) return;
  const r = await cp().saveFile(`contextpilot-config-${today()}.json`, JSON.stringify(c, null, 2));
  if (r.ok) toast(`Configuración exportada a ${r.path}`);
}

async function pickImport(): Promise<void> {
  const files = await cp().openJsonFiles(false);
  const f = files[0];
  if (!f) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(f.content);
  } catch {
    toast('El archivo no es JSON válido', true);
    return;
  }
  if (!looksLikeConfig(parsed)) {
    toast('El JSON no parece una configuración de ContextPilot', true);
    return;
  }
  // dryRun: el daemon valida y migra; si no soporta dryRun, se muestra el diff local.
  const dry = await cp().api<Config>('POST', '/config/import?dryRun=true', parsed);
  ui.importCandidate = { name: f.name, config: dry.ok && dry.data ? dry.data : (parsed as Partial<Config>) };
  if (!dry.ok) toast(`Validación del daemon: ${dry.error ?? dry.status}`, true);
  render();
}

async function applyImport(): Promise<void> {
  if (!ui.importCandidate) return;
  const c = await api<Config>('POST', '/config/import?dryRun=false', ui.importCandidate.config);
  if (c) {
    ui.importCandidate = undefined;
    ui.config = c;
    ui.form = configToForm(c);
    toast('Configuración importada');
    render();
  }
}

function renderSettings(root: HTMLElement): void {
  const f = ui.form;
  if (!f) {
    root.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'sin datos (daemon no disponible)'), h('button', { onclick: () => void loadConfig() }, 'Reintentar')));
    return;
  }
  root.append(h('div', { class: 'filters' },
    h('button', { class: 'primary', onclick: () => void saveConfig() }, 'Guardar'),
    h('button', { onclick: () => void loadConfig() }, 'Descartar cambios'),
    h('button', { onclick: () => void exportConfig() }, 'Exportar JSON'),
    h('button', { onclick: () => void pickImport() }, 'Importar JSON…'),
  ));
  if (ui.importCandidate && ui.config) {
    const changes = diffConfig(ui.config, { ...ui.config, ...ui.importCandidate.config });
    root.append(h('div', { class: 'card' },
      h('h2', {}, `Importar «${ui.importCandidate.name}» · ${changes.length} cambio(s)`),
      changes.length ? h('table', { class: 'diff' }, h('thead', {}, h('tr', {}, h('th', {}, 'Campo'), h('th', {}, 'Actual'), h('th', {}, 'Nuevo'))),
        h('tbody', {}, changes.slice(0, 200).map((c) => h('tr', {}, h('td', {}, c.path), h('td', {}, JSON.stringify(c.from) ?? '—'), h('td', {}, JSON.stringify(c.to) ?? '—')))))
        : h('div', { class: 'muted' }, 'Sin diferencias'),
      h('div', { class: 'form-row' }, h('button', { class: 'primary', onclick: () => void applyImport() }, 'Aplicar'), h('button', { onclick: () => { ui.importCandidate = undefined; render(); } }, 'Cancelar')),
    ));
  }
  root.append(h('div', { class: 'card' }, h('h2', {}, 'Reglas y umbrales'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Regla'), h('th', {}, 'Activa'), h('th', {}, 'Umbrales'), h('th', {}, 'Cooldown (min)'))),
      h('tbody', {}, f.rules.map((r) => h('tr', {},
        h('td', {}, h('strong', {}, r.id)),
        h('td', {}, h('input', { type: 'checkbox', checked: r.enabled, onchange: (e: Event) => (r.enabled = (e.target as HTMLInputElement).checked) })),
        h('td', {}, h('div', { class: 'form-row' }, r.thresholds.map((t) => h('label', {}, `${t.key} `, numInput(t.value, (v) => (t.value = v ?? NaN), ui.formErrors[`rules.${r.id}.${t.key}`]))))),
        h('td', {}, numInput(r.cooldownMin, (v) => (r.cooldownMin = v ?? NaN), ui.formErrors[`rules.${r.id}.cooldown`])),
      )))),
  ));
  root.append(h('div', { class: 'card' }, h('h2', {}, 'Adaptadores'),
    h('div', { class: 'form-row' }, f.adapters.map((a) => h('label', {}, h('input', { type: 'checkbox', checked: a.enabled, onchange: (e: Event) => (a.enabled = (e.target as HTMLInputElement).checked) }), ` ${a.name}`)))));
  root.append(h('div', { class: 'card' }, h('h2', {}, 'Perfiles de plan por proveedor'), f.plans.map(planEditor),
    h('div', { class: 'muted' }, 'Los proveedores no publican límites exactos de suscripción: los presets son puntos de partida «a calibrar».')));
  root.append(h('div', { class: 'card' }, h('h2', {}, 'Guardar contenido (opt-in por fuente)'),
    h('div', { class: 'form-row' }, f.storeContent.map((s) => h('label', {}, h('input', { type: 'checkbox', checked: s.enabled, onchange: (e: Event) => (s.enabled = (e.target as HTMLInputElement).checked) }), ` ${s.source}`))),
    h('div', { class: 'muted' }, 'Por defecto no se guarda contenido; sólo métricas y hashes (RNF-01).')));
}

// ---------------------------------------------------------------- Equipo (CP-057)

async function teamExport(): Promise<void> {
  const data = await api<unknown>('GET', '/team/export');
  if (!data) return;
  const r = await cp().saveFile(`contextpilot-equipo-${today()}.json`, JSON.stringify(data, null, 2));
  if (r.ok) toast(`Agregado anónimo guardado en ${r.path}`);
}

async function teamImport(): Promise<void> {
  const files = await cp().openJsonFiles(true);
  if (!files.length) return;
  ui.team = files.map((f) => parseTeamFile(f.name, f.content));
  render();
}

function renderTeam(root: HTMLElement): void {
  root.append(h('div', { class: 'filters' },
    h('button', { class: 'primary', onclick: () => void teamExport() }, 'Exportar mi agregado'),
    h('button', { onclick: () => void teamImport() }, 'Importar archivos del equipo…'),
    ui.team.length ? h('button', { onclick: () => { ui.team = []; render(); } }, 'Limpiar') : null,
  ));
  root.append(h('div', { class: 'muted', style: 'margin-bottom:12px' }, 'Sin servidor: cada persona exporta su agregado anónimo (sin ids, hashes ni rutas; buckets < 5 sesiones suprimidos) y acá se combinan los archivos.'));
  if (!ui.team.length) return;
  const agg = mergeTeam(ui.team);
  root.append(h('div', { class: 'kpis' },
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Archivos'), h('div', { class: 'v' }, agg.files.length)),
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Sesiones'), h('div', { class: 'v' }, agg.totals.sessions)),
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Sugerencias'), h('div', { class: 'v' }, agg.totals.suggestions)),
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Aceptación'), h('div', { class: 'v' }, agg.totals.acceptanceText)),
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, 'Ahorro estimado'), h('div', { class: 'v' }, agg.totals.savedText)),
  ));
  root.append(
    h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'Archivos importados'),
      h('table', {}, h('tbody', {}, agg.files.map((f) => h('tr', {}, h('td', {}, f.name), h('td', { class: 'num' }, `${f.rows} filas`),
        h('td', { class: f.warnings.length ? 'bad' : 'ok' }, f.warnings.length ? `⚠ ${f.warnings.join('; ')}` : '✓ sin señales de datos identificables')))))),
    h('div', { class: 'card' }, h('h2', {}, `Por proveedor · semanas ${agg.weeks.join(', ') || '—'}`),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Proveedor'), h('th', { class: 'num' }, 'Sesiones'), h('th', { class: 'num' }, 'Entrada'), h('th', { class: 'num' }, 'Salida'), h('th', { class: 'num' }, 'Caché'), h('th', { class: 'num' }, 'Ahorro'))),
        h('tbody', {}, agg.byProvider.map((p) => h('tr', {}, h('td', {}, p.provider), h('td', { class: 'num' }, p.sessions), h('td', { class: 'num' }, p.inputText), h('td', { class: 'num' }, p.outputText), h('td', { class: 'num' }, p.cacheText), h('td', { class: 'num' }, p.savedText)))))),
    h('div', { class: 'card' }, h('h2', {}, 'Por regla'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Regla'), h('th', { class: 'num' }, 'Sugerencias'), h('th', { class: 'num' }, 'Aceptadas'), h('th', { class: 'num' }, 'Aceptación'), h('th', { class: 'num' }, 'Ahorro'))),
        h('tbody', {}, agg.byRule.map((r) => h('tr', {}, h('td', {}, r.ruleId), h('td', { class: 'num' }, r.suggestions), h('td', { class: 'num' }, r.accepted), h('td', { class: 'num' }, r.acceptanceText), h('td', { class: 'num' }, r.savedText)))))),
  );
}

// ---------------------------------------------------------------- Shell

function renderConn(): void {
  const el = document.getElementById('conn')!;
  const s = ui.snapshot;
  el.textContent = !s ? '' : s.connection === 'connected' ? 'Daemon conectado' : 'Daemon no disponible';
  el.className = `conn status-dot ${s?.connection === 'connected' ? 'status-ok' : 'status-error'}`;
}

function render(): void {
  renderConn();
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]')) b.classList.toggle('active', b.dataset.tab === ui.tab);
  if (ui.tab === 'stats') return; // renderStats es async y dibuja solo
  const root = main();
  const scroll = root.scrollTop;
  clear(root);
  if (ui.tab === 'sessions') renderSessions(root);
  else if (ui.tab === 'settings') renderSettings(root);
  else if (ui.tab === 'team') renderTeam(root);
  root.scrollTop = scroll;
}

function go(tab: Tab): void {
  ui.tab = tab;
  render();
  if (tab === 'stats') void renderStats();
  if (tab === 'settings' && !ui.form) void loadConfig();
  if (tab === 'sessions') void loadSessions();
}

async function init(): Promise<void> {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]')) b.addEventListener('click', () => go(b.dataset.tab as Tab));
  cp().onSnapshot((s) => {
    const wasDown = ui.snapshot?.connection !== 'connected';
    ui.snapshot = s;
    renderConn();
    if (wasDown && s.connection === 'connected' && ui.tab === 'sessions') void loadSessions();
  });
  cp().onOpenSession((id) => {
    ui.tab = 'sessions';
    void loadDetail(id);
  });
  ui.snapshot = await cp().getSnapshot();
  const m = /session=([^&]+)/.exec(location.hash);
  if (m) ui.selected = decodeURIComponent(m[1]!);
  render();
  document.body.dataset.ready = '1';
  void loadSessions();
}

void init();
