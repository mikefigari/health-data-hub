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
