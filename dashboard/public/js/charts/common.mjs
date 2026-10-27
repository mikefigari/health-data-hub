// Shared pieces for the pure ECharts option builders (T6/T7).
// Pure: never touches window/document, so node unit tests can import it.
import { baseOption } from '../core.mjs';

export const ANIMATION_MS = 750;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// '#rrggbb' + alpha (0..1) -> 'rgba(r, g, b, a)'.
export function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(hex));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Vertical accent fade used under trend lines: accent at `top` alpha down to 0.
export function fadeGradient(hex, top = 0.25) {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: withAlpha(hex, top) },
      { offset: 1, color: withAlpha(hex, 0) },
    ],
  };
}

// 'YYYY-MM-DD' -> local-midnight timestamp, matching how ECharts parses date strings.
export function dayTs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}

export function addDays(day, n) {
  const t = new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000);
  return t.toISOString().slice(0, 10);
}

export function fmtTsDay(ts, withMonthOnly = false) {
  const d = new Date(ts);
  return withMonthOnly ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Common chart frame: motion, font, transparent background.
export function frame(tokens, { reducedMotion } = {}) {
  return {
    ...baseOption({ tokens, reducedMotion }),
    animation: !reducedMotion,
    animationDuration: ANIMATION_MS,
    animationDurationUpdate: 500,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
  };
}

export function grid(extra = {}) {
  return { left: 4, right: 8, top: 16, bottom: 4, containLabel: true, ...extra };
}

// At most MAX_TIME_LABELS evenly spaced x labels (local-midnight timestamps). ECharts' own
// time ticks add month-start labels off the rhythm ("Sep 29 Oct 1") and pack 4-day labels
// edge to edge on phones ("Oct 13Oct 17"), so the label positions are chosen here.
const MAX_TIME_LABELS = 6;
const DAY_STEPS = [1, 2, 3, 7, 14, 28];
export function timeLabelValues(min, max, monthOnly = false) {
  if (!isNum(min) || !isNum(max) || max <= min) return undefined;
  // A label centered on the right edge is clipped ("Oct 3"), so keep labels off the last 4%.
  const keep = (v) => max - v >= (max - min) * 0.04;
  return timeLabelCandidates(min, max, monthOnly).filter(keep);
}

function timeLabelCandidates(min, max, monthOnly) {
  const out = [];
  const d = new Date(min);
  d.setHours(0, 0, 0, 0);
  const spanDays = (max - min) / 86400000;
  if (monthOnly || spanDays / DAY_STEPS.at(-1) > MAX_TIME_LABELS) {
    d.setDate(1);
    if (d.getTime() < min) d.setMonth(d.getMonth() + 1);
    const months = [];
    for (; d.getTime() <= max; d.setMonth(d.getMonth() + 1)) months.push(d.getTime());
    const k = Math.ceil(months.length / MAX_TIME_LABELS);
    return months.filter((_, i) => i % k === 0);
  }
  const step = DAY_STEPS.find((s) => spanDays / s < MAX_TIME_LABELS);
  if (d.getTime() < min) d.setDate(d.getDate() + 1);
  // Weekly steps land on Mondays, matching the Monday-start weeks elsewhere.
  if (step >= 7) while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  for (; d.getTime() <= max; d.setDate(d.getDate() + step)) out.push(d.getTime());
  return out;
}

// Recessive axes: no axis line or ticks, labels in ink2, split lines in the grid token.
export function timeAxis(tokens, { min, max, monthOnly = false } = {}) {
  return {
    type: 'time',
    min,
    max,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: {
      color: tokens.ink2,
      fontSize: 11,
      hideOverlap: true,
      customValues: timeLabelValues(min, max, monthOnly),
      formatter: (v) => fmtTsDay(v, monthOnly),
    },
    axisPointer: { label: { show: false } },
  };
}

export function valueAxis(tokens, extra = {}) {
  const { axisLabel, splitLine, ...rest } = extra;
  return {
    type: 'value',
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: tokens.ink2, fontSize: 11, ...axisLabel },
    splitLine: { show: true, ...splitLine, lineStyle: { color: tokens.grid, width: 1, ...splitLine?.lineStyle } },
    ...rest,
  };
}

// Axis tooltip: crosshair on hover, also opens on tap/click (touch screens).
export function axisTooltip(tokens, formatter) {
  return {
    trigger: 'axis',
    triggerOn: 'mousemove|click',
    confine: true,
    backgroundColor: tokens.card,
    borderColor: tokens.grid,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: tokens.ink, fontSize: 12 },
    extraCssText: 'border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,0.12);',
    axisPointer: { type: 'line', lineStyle: { color: tokens.ink3, width: 1 } },
    formatter,
  };
}

// One tooltip row: colored marker carries identity, text stays in ink.
export const tipRow = (marker, name, value) =>
  `<div style="display:flex;gap:12px;justify-content:space-between"><span>${marker}${name}</span><b>${value}</b></div>`;
