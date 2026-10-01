import { ADAPTER_DOCS, fmtPct, fmtTokens, PLAN_DOCS, ruleDocFor, sessionNameOf, thresholdLabel, type Config, type RuleDoc } from '@contextpilot/core';
import {
  configToForm,
  diffConfig,
  formToConfig,
  isRecommended,
  looksLikeConfig,
  PLAN_PRESETS,
  PROVIDER_LABEL,
  restoreRecommended,
  type ConfigForm,
  type PlanForm,
  type RuleForm,
} from '../shared/configForm.js';
import { suggestionsCsv } from '../shared/csv.js';
import { distinct, filterSessions, statsQuery, statsView, type SessionFilter } from '../shared/stats.js';
import { mergeTeam, parseTeamFile, TEAM_EXAMPLE, TEAM_EXPORTED, TEAM_NEVER, teamExportView, type TeamFile } from '../shared/team.js';
import { timelineModel, timelineSvg } from '../shared/timeline.js';
import type { AdapterHealth, AppSnapshot, SessionDetail, SessionView, Stats } from '../shared/types.js';
import { clear, cp, h, toast } from './dom.js';
import { renderChat, updateChatSnapshot } from './chat.js';
import { renderLive, resetLive, setSetupNotice } from './live.js';
import { renderSetup, setupMissingCount } from './setup.js';

// Dashboard (CP-050, CP-051, CP-055 UI, CP-056 UI, CP-057 UI, CP-059..CP-063). Sin framework:
// render por pestaña. «En vivo» (default) se actualiza en el lugar con cada snapshot.

type Tab = 'live' | 'chat' | 'sessions' | 'stats' | 'settings' | 'team' | 'setup';

const ui = {
  tab: 'live' as Tab,
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
  /** CP-062: exportación propia (vista previa antes de guardar). */
  teamPreview: undefined as unknown,
  teamPreviewError: undefined as string | undefined,
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

/** «14:05» si es de hoy; si no, «29/09 14:05». */
function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

/** CP-061: nombre legible + id corto como texto secundario. */
function nameCell(s: SessionView): HTMLElement {
  const n = sessionNameOf(s);
  return h('div', { class: 'name-cell' }, h('div', { class: 'nm' }, n.name), h('div', { class: 'muted small' }, `${s.client || s.source} · `, h('span', { class: 'mono' }, n.shortId)));
}

function renderSessions(root: HTMLElement): void {
  root.append(filtersBar(true));
  const list = filterSessions(ui.sessions, ui.filter);
  const table = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Sesión'), h('th', {}, 'Modelo'), h('th', { class: 'num' }, 'Contexto'), h('th', {}, 'Último'))),
    h('tbody', {}, list.map((s) =>
      h('tr', { class: `click${s.sessionId === ui.selected ? ' sel' : ''}`, onclick: () => void loadDetail(s.sessionId) },
        h('td', { title: s.sessionId }, nameCell(s)),
        h('td', { class: 'secondary model' }, s.model),
        h('td', { class: 'num' }, s.contextWindow ? `${s.estimated ? '≈' : ''}${fmtPct(s.contextPct)}` : 'sin datos'),
        h('td', { class: 'secondary when', title: new Date(s.lastTurnAt).toLocaleString('es-AR') }, shortWhen(s.lastTurnAt)),
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
      h('h2', {}, `Timeline · ${sessionNameOf(d.view).name} · ${d.view.model}`),
      h('div', { class: 'legend' },
        h('span', {}, h('span', { class: 'sw s1' }), `Contexto (% de ${fmtTokens(d.view.contextWindow)})${d.view.estimated ? ' ≈' : ''}`),
        h('span', {}, h('span', { class: 'sw s2' }), 'Proporción de caché'),
        h('span', { class: 'muted' }, 'Sólo el hilo principal (los subagentes no cambian su contexto)'),
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

/** «1440 min» → «24 h». */
function fmtMin(m: number): string {
  return m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`;
}

/**
 * CP-063: ícono ⓘ con la configuración recomendada. Accesible por teclado: el botón muestra el
 * popover al enfocarlo o hacer clic (aria-expanded), Esc lo cierra.
 */
function infoPopover(doc: RuleDoc): HTMLElement {
  const id = `pop-${doc.id}`;
  const wrap = h('span', { class: 'info' });
  const setOpen = (open: boolean) => {
    wrap.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'info-btn',
      'aria-label': `Configuración recomendada de ${doc.id} (${doc.name})`,
      'aria-describedby': id,
      'aria-expanded': 'false',
      onclick: () => setOpen(!wrap.classList.contains('open')),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setOpen(false);
          btn.blur();
        }
      },
      onblur: () => setOpen(false),
    },
    'ⓘ',
  );
  const pop = h(
    'div',
    { class: 'popover', role: 'tooltip', id },
    h('strong', {}, `Recomendado · ${doc.id} ${doc.name}`),
    doc.thresholds.length
      ? h('ul', {}, doc.thresholds.map((t) => h('li', {}, h('b', {}, `${t.label}: ${t.valueText}`), t.why ? `. ${t.why}` : '')))
      : null,
    h('p', {}, h('b', {}, `Cooldown: ${fmtMin(doc.cooldownMin)}`), doc.cooldownWhy ? `. ${doc.cooldownWhy}` : ''),
    h('p', { class: 'muted' }, `Dónde: ${doc.account ? 'señal de cuenta (una por proveedor)' : doc.sourcesText}.${doc.requiresExact ? ' Sólo con cifras exactas (no estimadas).' : ''}`),
  );
  wrap.append(btn, pop);
  return wrap;
}

function ruleItem(r: RuleForm): HTMLElement {
  const doc = ruleDocFor(r.id);
  const rec = isRecommended(r);
  const restore = () => {
    if (!ui.form) return;
    const i = ui.form.rules.findIndex((x) => x.id === r.id);
    if (i >= 0) ui.form.rules[i] = restoreRecommended(r);
    render();
    toast(`${r.id}: valores recomendados (falta Guardar)`);
  };
  return h(
    'div',
    { class: `rule-item${r.enabled ? '' : ' off'}` },
    h(
      'div',
      { class: 'ri-head' },
      h('label', { class: 'ri-toggle' },
        h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `Activar ${r.id}`, onchange: (e: Event) => (r.enabled = (e.target as HTMLInputElement).checked) }),
        h('strong', {}, r.id), h('span', {}, doc?.name ?? '')),
      doc ? infoPopover(doc) : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'small-btn', disabled: rec, title: rec ? 'Ya tiene los valores recomendados' : 'Vuelve umbrales y cooldown a los recomendados (falta Guardar)', onclick: restore },
        rec ? 'Valores recomendados ✓' : 'Restaurar recomendado'),
    ),
    doc ? h('div', { class: 'ri-src muted small' }, doc.account ? 'Señal de cuenta (una por proveedor)' : `Dónde: ${doc.sourcesText}`, doc.requiresExact ? ' · sólo cifras exactas' : '') : null,
    doc ? h('p', { class: 'ri-detects' }, doc.detects) : null,
    doc ? h('p', { class: 'ri-why secondary' }, h('b', {}, 'Por qué importa: '), doc.why, ' ', h('b', {}, 'Qué sugiere: '), doc.suggests) : null,
    h(
      'div',
      { class: 'form-row ri-fields' },
      r.thresholds.map((t) =>
        h('label', { title: t.key }, `${thresholdLabel(r.id, t.key)} `, numInput(t.value, (v) => (t.value = v ?? NaN), ui.formErrors[`rules.${r.id}.${t.key}`])),
      ),
      h('label', { title: 'Tiempo mínimo entre dos avisos de esta regla en la misma sesión' }, 'Cooldown (min) ', numInput(r.cooldownMin, (v) => (r.cooldownMin = v ?? NaN), ui.formErrors[`rules.${r.id}.cooldown`])),
    ),
  );
}

function renderSettings(root: HTMLElement): void {
  const f = ui.form;
  if (!f) {
    root.append(h('div', { class: 'card' }, h('div', { class: 'muted' }, 'sin datos (daemon no disponible)'), h('button', { onclick: () => void loadConfig() }, 'Reintentar')));
    return;
  }
  root.append(h('div', { class: 'filters sticky' },
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
  root.append(h('div', { class: 'card' },
    h('h2', {}, 'Reglas'),
    h('p', { class: 'secondary intro' },
      'Cada regla detecta un patrón que gasta tokens de más y sugiere una acción. Los umbrales recomendados salen de mediciones con datos reales; ',
      'pasá el mouse o el foco por ⓘ para ver por qué. «Cooldown» = tiempo mínimo entre dos avisos de la misma regla en la misma sesión.'),
    h('div', { class: 'rules-list' }, f.rules.map(ruleItem)),
  ));
  root.append(h('div', { class: 'card' }, h('h2', {}, 'Perfiles de plan por proveedor'),
    h('p', { class: 'secondary intro' }, PLAN_DOCS.intro),
    h('ul', { class: 'secondary intro' }, h('li', {}, PLAN_DOCS.subscription), h('li', {}, PLAN_DOCS.api)),
    f.plans.map(planEditor)));
  root.append(h('div', { class: 'card' }, h('h2', {}, 'Adaptadores (de dónde lee ContextPilot)'),
    h('div', { class: 'adapters' }, f.adapters.map((a) =>
      h('label', { class: 'adapter' },
        h('input', { type: 'checkbox', checked: a.enabled, onchange: (e: Event) => (a.enabled = (e.target as HTMLInputElement).checked) }),
        h('span', {}, h('strong', {}, a.name), h('span', { class: 'muted small' }, ADAPTER_DOCS[a.name] ?? '')))))));
  root.append(h('div', { class: 'card' }, h('h2', {}, 'Guardar contenido (opt-in por fuente)'),
    h('div', { class: 'form-row' }, f.storeContent.map((s) => h('label', {}, h('input', { type: 'checkbox', checked: s.enabled, onchange: (e: Event) => (s.enabled = (e.target as HTMLInputElement).checked) }), ` ${s.source}`))),
    h('div', { class: 'muted' }, 'Por defecto no se guarda contenido; sólo métricas y hashes (RNF-01). Los títulos de conversación se muestran pero nunca se guardan.')));
}

// ---------------------------------------------------------------- Equipo (CP-057)

/** CP-062: trae la exportación propia para mostrarla antes de guardarla. */
async function loadTeamPreview(): Promise<void> {
  const r = await cp().api<unknown>('GET', '/team/export');
  ui.teamPreview = r.ok ? r.data : undefined;
  ui.teamPreviewError = r.ok && r.data !== undefined ? undefined : (r.error ?? `respuesta ${r.status}`);
  if (ui.tab === 'team') render();
}

async function teamSave(): Promise<void> {
  if (!ui.teamPreview) await loadTeamPreview();
  if (!ui.teamPreview) return;
  const r = await cp().saveFile(`contextpilot-equipo-${today()}.json`, JSON.stringify(ui.teamPreview, null, 2));
  if (r.ok) toast(`Agregado anónimo guardado en ${r.path}`);
}

async function teamImport(): Promise<void> {
  const files = await cp().openJsonFiles(true);
  if (!files.length) return;
  ui.team = files.map((f) => parseTeamFile(f.name, f.content));
  render();
}

function kpi(label: string, value: string | number, hint?: string): HTMLElement {
  return h('div', { class: 'kpi' }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), hint ? h('div', { class: 't muted' }, hint) : null);
}

function teamPreviewCard(): HTMLElement {
  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, '1 · Tu agregado (vista previa de lo que se guardaría)'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => void loadTeamPreview() }, 'Actualizar vista previa'),
      h('button', { class: 'primary', onclick: () => void teamSave() }, 'Guardar archivo…')));
  if (ui.teamPreviewError) {
    card.append(h('div', { class: 'muted' }, `No se pudo generar la vista previa: ${ui.teamPreviewError}`));
    return card;
  }
  if (ui.teamPreview === undefined) {
    card.append(h('div', { class: 'muted' }, 'Generando vista previa…'));
    return card;
  }
  const v = teamExportView(ui.teamPreview);
  if (!v.ok) {
    card.append(h('div', { class: 'muted' }, v.error ?? 'Formato desconocido'));
    return card;
  }
  card.append(h('p', { class: 'secondary intro' }, `Últimos 7 días · semanas ISO ${v.weeksText} · generado ${v.generatedAt}. ${v.suppressedText}`));
  if (v.empty) {
    card.append(h('div', { class: 'callout' },
      h('strong', {}, 'Todavía no hay nada para compartir. '),
      `Ningún grupo (semana × proveedor o semana × regla) llega a 5 sesiones, así que se ocultan todos: el archivo saldría vacío. Es a propósito: un grupo chico podría identificar a una persona.`));
    return card;
  }
  card.append(h('div', { class: 'kpis' },
    kpi('Sesiones', v.totals.sessions),
    kpi('Tokens', v.totals.tokensText, 'entrada + salida + caché'),
    kpi('Sugerencias', v.totals.suggestions),
    kpi('Aceptación', v.totals.acceptanceText, `${v.totals.accepted} aceptadas`),
    kpi('Ahorro estimado', v.totals.savedText, 'tokens, sólo aceptadas'),
  ));
  if (v.providers.length) {
    card.append(h('h3', {}, 'Por proveedor'), h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Semana'), h('th', {}, 'Proveedor'), h('th', { class: 'num' }, 'Sesiones'), h('th', { class: 'num' }, 'Entrada'), h('th', { class: 'num' }, 'Salida'), h('th', { class: 'num' }, 'Desde caché'), h('th', { class: 'num' }, 'Sugerencias'), h('th', { class: 'num' }, 'Aceptación'), h('th', { class: 'num' }, 'Ahorro'))),
      h('tbody', {}, v.providers.map((p) => h('tr', {}, h('td', {}, p.week), h('td', {}, p.provider), h('td', { class: 'num' }, p.sessions), h('td', { class: 'num' }, p.inputText), h('td', { class: 'num' }, p.outputText), h('td', { class: 'num' }, p.cacheText), h('td', { class: 'num' }, p.suggestions), h('td', { class: 'num' }, p.acceptanceText), h('td', { class: 'num' }, p.savedText))))));
  }
  if (v.rules.length) {
    card.append(h('h3', {}, 'Por regla'), h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Semana'), h('th', {}, 'Regla'), h('th', { class: 'num' }, 'Sesiones'), h('th', { class: 'num' }, 'Mostradas'), h('th', { class: 'num' }, 'Aceptadas'), h('th', { class: 'num' }, 'Ignoradas'), h('th', { class: 'num' }, 'Pospuestas'), h('th', { class: 'num' }, 'Aceptación'), h('th', { class: 'num' }, 'Ahorro'))),
      h('tbody', {}, v.rules.map((r) => h('tr', {}, h('td', {}, r.week), h('td', {}, `${r.ruleId} · ${r.ruleName}`), h('td', { class: 'num' }, r.sessions), h('td', { class: 'num' }, r.fired), h('td', { class: 'num' }, r.accepted), h('td', { class: 'num' }, r.dismissed), h('td', { class: 'num' }, r.snoozed), h('td', { class: 'num' }, r.acceptanceText), h('td', { class: 'num' }, r.savedText))))));
  }
  return card;
}

function renderTeam(root: HTMLElement): void {
  root.append(h('div', { class: 'card team-intro' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Equipo: comparar hábitos de uso sin exponer a nadie'), h('span', { class: 'spacer' }),
      h('span', { class: 'pill warn-pill' }, 'Pendiente de aprobación de seguridad (H-3): no compartir archivos reales todavía')),
    h('p', {}, h('b', {}, 'Qué es. '), 'Cada persona genera un resumen anónimo de su uso de la semana; el lead junta los archivos acá y ve qué buenas prácticas funcionan en el equipo (qué reglas se aceptan, cuánto ahorran) para difundirlas. No hay servidor: son archivos que se pasan a mano.'),
    h('p', {}, h('b', {}, 'Para quién. '), 'Leads y equipos que quieren comparar hábitos (compactar a tiempo, sesiones por tarea, caché) sin mirar conversaciones de nadie.'),
    h('div', { class: 'two-col' },
      h('div', { class: 'yes' }, h('h3', {}, 'Qué se exporta'), h('ul', {}, TEAM_EXPORTED.map((t) => h('li', {}, t)))),
      h('div', { class: 'no' }, h('h3', {}, 'Qué NUNCA se exporta'), h('ul', {}, TEAM_NEVER.map((t) => h('li', {}, t))))),
  ));
  root.append(teamPreviewCard());

  const merge = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, '2 · Combinar archivos del equipo'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: () => void teamImport() }, 'Elegir archivos…'),
      ui.team.length ? h('button', { onclick: () => { ui.team = []; render(); } }, 'Limpiar') : null),
    h('ol', { class: 'secondary intro' },
      h('li', {}, 'Cada integrante guarda su archivo con «Guardar archivo…» (paso 1).'),
      h('li', {}, 'Te lo pasa (chat, correo, carpeta compartida).'),
      h('li', {}, 'Elegís todos los archivos acá: se suman por semana, proveedor y regla. Si un archivo trae algo que parece identificable (ids, rutas, hashes), se marca con ⚠.')),
    h('details', { class: 'example' }, h('summary', {}, 'Ver un archivo de ejemplo'), h('pre', {}, TEAM_EXAMPLE)),
  );
  root.append(merge);
  if (!ui.team.length) return;
  const agg = mergeTeam(ui.team);
  merge.append(
    h('div', { class: 'kpis' },
      kpi('Archivos', agg.files.length),
      kpi('Sesiones', agg.totals.sessions),
      kpi('Sugerencias', agg.totals.suggestions),
      kpi('Aceptación', agg.totals.acceptanceText),
      kpi('Ahorro estimado', agg.totals.savedText, 'tokens'),
    ),
    h('h3', {}, 'Archivos'),
    h('table', {}, h('tbody', {}, agg.files.map((f) => h('tr', {}, h('td', {}, f.name), h('td', { class: 'num' }, `${f.rows} filas`),
      h('td', { class: f.warnings.length ? 'bad' : 'ok' }, f.warnings.length ? `⚠ ${f.warnings.join('; ')}` : '✓ sin señales de datos identificables'))))),
    h('h3', {}, `Por proveedor · semanas ${agg.weeks.join(', ') || '—'}`),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Proveedor'), h('th', { class: 'num' }, 'Sesiones'), h('th', { class: 'num' }, 'Entrada'), h('th', { class: 'num' }, 'Salida'), h('th', { class: 'num' }, 'Desde caché'), h('th', { class: 'num' }, 'Ahorro'))),
      h('tbody', {}, agg.byProvider.map((p) => h('tr', {}, h('td', {}, p.provider), h('td', { class: 'num' }, p.sessions), h('td', { class: 'num' }, p.inputText), h('td', { class: 'num' }, p.outputText), h('td', { class: 'num' }, p.cacheText), h('td', { class: 'num' }, p.savedText))))),
    h('h3', {}, 'Por regla (qué buenas prácticas adopta el equipo)'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Regla'), h('th', { class: 'num' }, 'Mostradas'), h('th', { class: 'num' }, 'Aceptadas'), h('th', { class: 'num' }, 'Aceptación'), h('th', { class: 'num' }, 'Ahorro'))),
      h('tbody', {}, agg.byRule.map((r) => h('tr', {}, h('td', {}, `${r.ruleId} · ${ruleDocFor(r.ruleId)?.name ?? ''}`), h('td', { class: 'num' }, r.suggestions), h('td', { class: 'num' }, r.accepted), h('td', { class: 'num' }, r.acceptanceText), h('td', { class: 'num' }, r.savedText))))),
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
  if (ui.tab === 'live') {
    // CP-059: se actualiza en el lugar (sin limpiar: transiciones de color y foco).
    renderLive(root, ui.snapshot);
    return;
  }
  resetLive();
  if (ui.tab === 'chat') {
    void renderChat(root, ui.snapshot);
    return;
  }
  if (ui.tab === 'setup') {
    void renderSetup(root);
    return;
  }
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
  if (tab === 'team') void loadTeamPreview();
}

async function init(): Promise<void> {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]')) b.addEventListener('click', () => go(b.dataset.tab as Tab));
  cp().onSnapshot((s) => {
    const wasDown = ui.snapshot?.connection !== 'connected';
    ui.snapshot = s;
    renderConn();
    if (ui.tab === 'live') renderLive(main(), s);
    if (ui.tab === 'chat') updateChatSnapshot(s);
    if (wasDown && s.connection === 'connected' && ui.tab === 'sessions') void loadSessions();
  });
  cp().onOpenSession((id) => {
    ui.tab = 'sessions';
    void loadDetail(id);
  });
  window.addEventListener('cp:go', (e) => go((e as CustomEvent<Tab>).detail));
  ui.snapshot = await cp().getSnapshot();
  const m = /session=([^&]+)/.exec(location.hash);
  if (m) ui.selected = decodeURIComponent(m[1]!);
  if (m) ui.tab = 'sessions';
  render();
  document.body.dataset.ready = '1';
  void loadSessions();
  // Puesta en marcha: si falta algo obligatorio, se abre esa pestaña al iniciar y «En vivo» lo avisa.
  const refreshSetup = async (first: boolean) => {
    const n = await setupMissingCount();
    setSetupNotice(n);
    if (first && n && !m) go('setup');
    else if (ui.tab === 'live') renderLive(main(), ui.snapshot);
  };
  void refreshSetup(true);
  window.setInterval(() => void refreshSetup(false), 60_000);
  // «hace N min», cuenta regresiva de la caché y rotación de consejos.
  window.setInterval(() => {
    if (ui.tab === 'live') renderLive(main(), ui.snapshot);
  }, 10_000);
}

void init();
