import { fmtPct, fmtTokens } from '@contextpilot/core';
import type { SuggestionWithFeedback, TimelinePoint } from './types.js';

// CP-050.1: gráfico de timeline por sesión en SVG inline (sin librería).
// Un solo eje (0–100 %): ocupación de contexto y proporción de caché comparten unidad.
// Colores por rol vía CSS (--series-1 / --series-2 / --muted), definidos en styles.css con modo oscuro.

export interface TimelineModel {
  width: number;
  height: number;
  context: { x: number; y: number; pct: number; label: string }[];
  cache: { x: number; y: number; pct: number; label: string }[];
  markers: { x: number; id: string; ruleId: string; feedback: string; glyph: string; label: string }[];
  xTicks: { x: number; label: string }[];
  yTicks: { y: number; label: string }[];
  empty: boolean;
}

const PAD = { l: 40, r: 64, t: 12, b: 24 };
/** CP-065: por encima de esta cantidad de puntos (tras decimar) no se dibujan círculos por punto. */
export const MAX_DOTS = 60;
/** CP-065 (filas previas a v2, sin marca de subagente): caída relativa que se considera «otro hilo». */
export const LEGACY_DIP = 0.6;
/** CP-065: si el contexto vuelve al nivel previo dentro de este lapso, la caída fue un subagente. */
export const LEGACY_RECOVERY_MS = 10 * 60_000;

/**
 * CP-065: puntos del hilo principal. Las llamadas de subagente (`sidechain: true`) no cambian el
 * contexto de la sesión: no se grafican. Filas viejas sin marca (`null`/ausente): una caída por
 * debajo del 60 % del último contexto principal que se recupera dentro de 10 min es un subagente
 * (una compactación real no se recupera tan rápido); si no se recupera, es una caída real.
 */
export function mainThreadPoints<T extends Pick<TimelinePoint, 'ts' | 'contextSize' | 'sidechain'>>(points: T[]): T[] {
  const out: T[] = [];
  let mainCtx = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.sidechain === true) continue;
    if (p.sidechain === false || mainCtx === 0 || p.contextSize >= mainCtx * LEGACY_DIP) {
      out.push(p);
      mainCtx = p.contextSize;
      continue;
    }
    const t = Date.parse(p.ts);
    let recovers = false;
    for (let j = i + 1; j < points.length; j++) {
      const q = points[j]!;
      if (Date.parse(q.ts) - t > LEGACY_RECOVERY_MS) break;
      if (q.sidechain === true) continue;
      if (q.contextSize >= mainCtx * LEGACY_DIP) {
        recovers = true;
        break;
      }
    }
    if (recovers) continue;
    out.push(p);
    mainCtx = p.contextSize;
  }
  return out;
}

/**
 * CP-065: decimación por columna de píxel (M4): de cada columna quedan el primero, el mínimo, el
 * máximo y el último (en orden), así la línea conserva la envolvente sin clusters verticales densos.
 */
export function decimate<T extends { x: number; y: number }>(pts: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < pts.length) {
    const col = Math.floor(pts[i]!.x);
    let j = i;
    while (j + 1 < pts.length && Math.floor(pts[j + 1]!.x) === col) j++;
    if (j - i < 2) {
      for (let k = i; k <= j; k++) out.push(pts[k]!);
    } else {
      let lo = i;
      let hi = i;
      for (let k = i; k <= j; k++) {
        if (pts[k]!.y < pts[lo]!.y) lo = k;
        if (pts[k]!.y > pts[hi]!.y) hi = k;
      }
      for (const k of [...new Set([i, lo, hi, j])].sort((a, b) => a - b)) out.push(pts[k]!);
    }
    i = j + 1;
  }
  return out;
}

const FEEDBACK_GLYPH: Record<string, { glyph: string; text: string }> = {
  accepted: { glyph: '✓', text: 'aceptada' },
  dismissed: { glyph: '✕', text: 'ignorada' },
  snoozed: { glyph: '⏸', text: 'pospuesta' },
  expired: { glyph: '·', text: 'vencida' },
  none: { glyph: '!', text: 'sin respuesta' },
};

function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function timelineModel(
  points: TimelinePoint[],
  contextWindow: number,
  suggestions: SuggestionWithFeedback[],
  width = 720,
  height = 240,
): TimelineModel {
  const pts = mainThreadPoints(points.filter((p) => Number.isFinite(Date.parse(p.ts))).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ y: PAD.t + (1 - v) * (height - PAD.t - PAD.b), label: fmtPct(v) }));
  if (!pts.length) return { width, height, context: [], cache: [], markers: [], xTicks: [], yTicks, empty: true };

  const sugTimes = suggestions.map((s) => Date.parse(s.createdAt ?? '')).filter(Number.isFinite);
  const t0 = Math.min(Date.parse(pts[0]!.ts), ...sugTimes);
  const t1 = Math.max(Date.parse(pts.at(-1)!.ts), ...sugTimes);
  const span = Math.max(1, t1 - t0);
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + (pts.length === 1 && !sugTimes.length ? iw / 2 : ((t - t0) / span) * iw);
  const y = (v: number) => PAD.t + (1 - Math.max(0, Math.min(1, v))) * ih;

  const context = decimate(pts.map((p) => {
    const pct = contextWindow ? p.contextSize / contextWindow : 0;
    const t = Date.parse(p.ts);
    return {
      x: x(t),
      y: y(pct),
      pct,
      label: `${hhmm(t)} · contexto ${p.estimated ? '≈' : ''}${fmtPct(pct)} (${fmtTokens(p.contextSize)})`,
    };
  }));
  const cache = decimate(pts
    .filter((p) => p.cacheRatio !== null && p.cacheRatio !== undefined)
    .map((p) => {
      const t = Date.parse(p.ts);
      return { x: x(t), y: y(p.cacheRatio!), pct: p.cacheRatio!, label: `${hhmm(t)} · caché ${fmtPct(p.cacheRatio!)}` };
    }));
  const markers = suggestions
    .filter((s) => Number.isFinite(Date.parse(s.createdAt ?? '')))
    .map((s) => {
      const fb = FEEDBACK_GLYPH[s.feedback ?? 'none'] ?? FEEDBACK_GLYPH.none!;
      const t = Date.parse(s.createdAt!);
      return { x: x(t), id: s.id, ruleId: s.ruleId, feedback: s.feedback ?? 'none', glyph: fb.glyph, label: `${hhmm(t)} · ${s.ruleId} ${s.title} (${fb.text})` };
    });
  const nTicks = Math.min(6, Math.max(2, pts.length));
  const xTicks = Array.from({ length: nTicks }, (_, i) => {
    const t = t0 + (span * i) / (nTicks - 1);
    return { x: x(t), label: hhmm(t) };
  });
  return { width, height, context, cache, markers, xTicks, yTicks, empty: false };
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function path(pts: { x: number; y: number }[]): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/** SVG listo para insertar. Cada punto y marcador lleva <title> (tooltip nativo al pasar el mouse). */
export function timelineSvg(m: TimelineModel): string {
  const { width: w, height: h } = m;
  const parts: string[] = [
    `<svg class="timeline" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Contexto y caché por turno">`,
  ];
  for (const t of m.yTicks) {
    parts.push(`<line class="grid" x1="${PAD.l}" x2="${w - PAD.r}" y1="${t.y}" y2="${t.y}"/>`);
    parts.push(`<text class="axis" x="${PAD.l - 6}" y="${t.y + 4}" text-anchor="end">${t.label}</text>`);
  }
  if (m.empty) {
    parts.push(`<text class="axis" x="${w / 2}" y="${h / 2}" text-anchor="middle">sin datos</text></svg>`);
    return parts.join('');
  }
  for (const t of m.xTicks) parts.push(`<text class="axis" x="${t.x}" y="${h - 6}" text-anchor="middle">${t.label}</text>`);
  for (const mk of m.markers) {
    parts.push(
      `<g class="marker fb-${mk.feedback}"><line x1="${mk.x}" x2="${mk.x}" y1="${PAD.t}" y2="${h - PAD.b}"/>` +
        `<text x="${mk.x}" y="${PAD.t + 10}" text-anchor="middle">${escapeXml(mk.glyph)}</text>` +
        `<rect class="hit" x="${mk.x - 8}" y="${PAD.t}" width="16" height="${h - PAD.t - PAD.b}"><title>${escapeXml(mk.label)}</title></rect></g>`,
    );
  }
  if (m.context.length) parts.push(`<path class="line s1" d="${path(m.context)}"/>`);
  if (m.cache.length) parts.push(`<path class="line s2" d="${path(m.cache)}"/>`);
  // CP-065: con muchos puntos, sólo la línea (más el último punto de cada serie, con su tooltip).
  const dots = (pts: TimelineModel['context']) => (pts.length <= MAX_DOTS ? pts : pts.slice(-1));
  for (const p of dots(m.context)) parts.push(`<circle class="pt s1" cx="${p.x}" cy="${p.y}" r="4"><title>${escapeXml(p.label)}</title></circle>`);
  for (const p of dots(m.cache)) parts.push(`<circle class="pt s2" cx="${p.x}" cy="${p.y}" r="4"><title>${escapeXml(p.label)}</title></circle>`);
  // Etiquetas directas al final de cada serie (además de la leyenda).
  const lastC = m.context.at(-1);
  const lastK = m.cache.at(-1);
  if (lastC) parts.push(`<text class="label" x="${w - PAD.r + 6}" y="${lastC.y + 4}">contexto</text>`);
  if (lastK) parts.push(`<text class="label" x="${w - PAD.r + 6}" y="${lastK.y + (lastC && Math.abs(lastC.y - lastK.y) < 12 ? 14 : 4)}">caché</text>`);
  parts.push('</svg>');
  return parts.join('');
}
