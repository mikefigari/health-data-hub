// Calories by macro (Cronometer style): rounded stacked kcal bars against a dashed goal
// step line, and protein bars against the protein goal. Pure builders.
import { fmtDay, fmtInt } from '../core.mjs';
import { axisTooltip, frame, grid, isNum, tipRow, valueAxis, withAlpha } from './common.mjs';

export const EMPTY_NUTRITION = 'No food logged in this range';
const MACROS = ['protein', 'carbs', 'fat', 'other'];
const LABEL = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat', other: 'Other' };
const DAY_KEY = { protein: 'kcal_protein', carbs: 'kcal_carbs', fat: 'kcal_fat', other: 'kcal_other' };
const WEEK_KEY = { protein: 'avg_kcal_protein', carbs: 'avg_kcal_carbs', fat: 'avg_kcal_fat', other: 'avg_kcal_other' };
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };
const TOP_RADIUS = [6, 6, 0, 0];
const BAR_MAX = 28;
const PARTIAL_OPACITY = 0.6;
const UNMET_ALPHA = 0.45;
const PLACEHOLDER_ALPHA = 0.14;
const STACK = 'kcal';

const rangeOf = (data, opts) => opts?.range ?? data?.range_days ?? 30;
const isWeekly = (data, opts) => rangeOf(data, opts) > 30;
const SHOWN = new Set(['logged', 'partial', 'incomplete']);
const NOTE = { missing: 'Not logged', incomplete: 'Marked incomplete' };

// Rows the chart draws: one per day (7D/30D) or one per Monday-start week (90D/1Y).
function rowsOf(data, opts) {
  const weekly = isWeekly(data, opts);
  return { weekly, rows: (weekly ? data?.nutrition?.weeks : data?.nutrition?.days) || [] };
}
const catOf = (row, weekly) => (weekly ? row.week_start : row.day);
const hasFood = (row, weekly) => (weekly ? row.days_logged > 0 : SHOWN.has(row.status));

const dot = (color) =>
  `<span style="display:inline-block;width:8px;height:8px;border-radius:4px;margin-right:6px;background:${color}"></span>`;
const head = (tokens, text) => `<div style="color:${tokens.ink2};margin-bottom:4px">${text}</div>`;
const note = (tokens, text) => `<div style="color:${tokens.ink2};margin-top:4px">${text}</div>`;
const headText = (row, weekly) => (weekly ? `Week of ${fmtDay(row.week_start)}` : fmtDay(row.day));

function categoryAxis(tokens, cats) {
  return {
    type: 'category',
    data: cats,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: tokens.ink2, fontSize: 11, hideOverlap: true, formatter: (v) => fmtDay(v) },
    axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(tokens.ink3, 0.08) }, label: { show: false } },
  };
}

// Header subtitle for the calories card.
export function caloriesSubtitle(data, opts = {}) {
  return isWeekly(data, opts) ? 'Weekly average · kcal by macro' : 'Daily kcal by macro';
}

export function caloriesOption(data, tokens, opts = {}) {
  const { weekly, rows } = rowsOf(data, opts);
  if (!rows.some((r) => hasFood(r, weekly))) return { empty: EMPTY_NUTRITION };
  const keys = weekly ? WEEK_KEY : DAY_KEY;
  const color = { protein: tokens.protein, carbs: tokens.carbs, fat: tokens.fat, other: tokens.ink3 };

  // Per-row kcal parts; placeholder days (missing/incomplete) draw no macro segments.
  const parts = rows.map((row) => {
    const draw = weekly ? row.days_logged > 0 : row.status === 'logged' || row.status === 'partial';
    return MACROS.map((m) => (draw && isNum(row[keys[m]]) ? row[keys[m]] : 0));
  });
  const topOf = parts.map((vals) => vals.map((v) => v > 0).lastIndexOf(true));
  const goals = rows.map((row) => (weekly ? row.avg_goal_calories : row.goal_calories) ?? null);

  const macroSeries = MACROS.map((m, k) => ({
    name: m,
    type: 'bar',
    stack: STACK,
    barMaxWidth: BAR_MAX,
    barCategoryGap: '30%',
    z: 2,
    itemStyle: { color: color[m] },
    emphasis: { disabled: true },
    data: rows.map((row, i) => {
      const v = parts[i][k];
      const style = {};
      if (topOf[i] === k) style.borderRadius = TOP_RADIUS;
      if (!weekly && row.status === 'partial') style.opacity = PARTIAL_OPACITY;
      return Object.keys(style).length ? { value: v || null, itemStyle: style } : v || null;
    }),
  }));

  // Missing / marked-incomplete days: a faint bar at goal height so the gap reads as a gap.
  const placeholder = {
    name: 'placeholder',
    type: 'bar',
    stack: STACK,
    barMaxWidth: BAR_MAX,
    z: 1,
    silent: true,
    itemStyle: { color: withAlpha(tokens.ink3, PLACEHOLDER_ALPHA), borderRadius: TOP_RADIUS },
    emphasis: { disabled: true },
    data: rows.map((row, i) =>
      !weekly && (row.status === 'missing' || row.status === 'incomplete') && isNum(goals[i]) ? goals[i] : null
    ),
  };

  const goal = {
    name: 'goal',
    type: 'line',
    step: 'middle',
    data: goals,
    symbol: 'none',
    showSymbol: false,
    connectNulls: true,
    z: 3,
    silent: true,
    lineStyle: { type: 'dashed', width: 1.5, color: tokens.ink2 },
    itemStyle: { color: tokens.ink2 },
    emphasis: { disabled: true },
  };

  // The goal line and the placeholders are series, so the auto y-range already covers them.
  const tooltip = axisTooltip(tokens, (params) => {
    const ps = Array.isArray(params) ? params : [params];
    const i = ps[0]?.dataIndex;
    const row = rows[i];
    if (!row) return '';
    const g = goals[i];
    const goalRow = tipRow(dot(tokens.ink2), weekly ? 'Avg goal' : 'Goal', `${fmtInt(g)} kcal`);
    if (!hasFood(row, weekly)) {
      return head(tokens, headText(row, weekly)) + (isNum(g) ? goalRow : '') + note(tokens, NOTE.missing);
    }
    const kcal = weekly ? row.avg_calories : row.calories;
    const grams = (m) => {
      if (!weekly) return row[`${m}_g`];
      if (m === 'protein' && isNum(row.avg_protein_g)) return row.avg_protein_g;
      return isNum(row[WEEK_KEY[m]]) ? row[WEEK_KEY[m]] / KCAL_PER_G[m] : null;
    };
    const suffix = !weekly && row.status === 'partial' ? ' so far' : '';
    const lines = [tipRow('', weekly ? 'Avg calories' : 'Calories', `${fmtInt(kcal)} kcal${suffix}`)];
    for (const m of ['protein', 'carbs', 'fat']) lines.push(tipRow(dot(color[m]), LABEL[m], `${fmtInt(grams(m))} g`));
    if (isNum(g)) lines.push(goalRow);
    let foot = '';
    if (weekly) foot = note(tokens, `${row.days_logged} ${row.days_logged === 1 ? 'day' : 'days'} logged`);
    else if (row.status === 'incomplete') foot = note(tokens, NOTE.incomplete);
    return head(tokens, headText(row, weekly)) + lines.join('') + foot;
  });

  return {
    ...frame(tokens, opts),
    grid: grid({ top: 30 }),
    legend: {
      show: true,
      top: 0,
      left: 0,
      data: MACROS,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 12,
      selectedMode: false,
      formatter: (n) => LABEL[n] || n,
      textStyle: { color: tokens.ink2, fontSize: 11 },
    },
    tooltip,
    xAxis: categoryAxis(tokens, rows.map((r) => catOf(r, weekly))),
    yAxis: valueAxis(tokens, { splitNumber: 4, axisLabel: { formatter: (v) => fmtInt(v) } }),
    series: [...macroSeries, placeholder, goal],
  };
}

// Header caption for the protein card: "Goal met N of M days".
export function proteinCaption(data) {
  const s = data?.nutrition?.summary || {};
  return `Goal met ${s.protein_days_met ?? 0} of ${s.days_logged ?? 0} days`;
}

// Card header hero for protein: average grams over complete logged days in the range.
export function proteinHero(data) {
  const days = (data?.nutrition?.days || []).filter((d) => d.status === 'logged' && isNum(d.protein_g));
  const avg = days.length ? days.reduce((a, d) => a + d.protein_g, 0) / days.length : null;
  return { value: fmtInt(avg), unit: 'g avg', caption: proteinCaption(data) };
}

// 1, 2, 2.5 or 5 times a power of ten, at least `raw`.
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}

const fmtG = (g) => (Number.isInteger(g) ? String(g) : g.toFixed(1));

export function proteinOption(data, tokens, opts = {}) {
  const { weekly, rows } = rowsOf(data, opts);
  if (!rows.some((r) => hasFood(r, weekly))) return { empty: EMPTY_NUTRITION };
  const accent = tokens.protein;
  const goalOf = (row) => (weekly ? row.avg_goal_protein_g : row.goal_protein_g) ?? data?.goals?.protein_g ?? null;
  const target = data?.goals?.protein_g ?? rows.map(goalOf).find(isNum) ?? null;
  // Marked-incomplete days draw no bar (as in the calories chart); the tooltip says why.
  const valueOf = (row) => {
    if (!hasFood(row, weekly) || (!weekly && row.status === 'incomplete')) return null;
    const v = weekly ? row.avg_protein_g : row.protein_g;
    return isNum(v) ? v : null;
  };
  const vals = rows.map(valueOf);

  const bars = {
    name: 'protein',
    type: 'bar',
    barMaxWidth: BAR_MAX,
    barCategoryGap: '30%',
    z: 2,
    itemStyle: { color: accent, borderRadius: TOP_RADIUS },
    emphasis: { disabled: true },
    data: rows.map((row, i) => {
      const v = vals[i];
      if (v == null) return null;
      const g = goalOf(row);
      const met = isNum(g) && v >= g;
      const style = { color: met ? accent : withAlpha(accent, UNMET_ALPHA) };
      if (!weekly && row.status === 'partial') style.opacity = PARTIAL_OPACITY;
      return { value: v, itemStyle: style };
    }),
  };
  if (isNum(target)) {
    bars.markLine = {
      silent: true,
      symbol: 'none',
      animation: false,
      lineStyle: { type: 'dashed', color: tokens.ink2, width: 1.5 },
      label: { formatter: `${fmtG(target)} g`, position: 'insideEndTop', color: tokens.ink2, fontSize: 11 },
      data: [{ yAxis: target }],
    };
  }

  // markLine is not part of the auto y-range: keep the goal inside the axis explicitly.
  // The max is a whole number of ticks, so no stray top label crowds the last tick (220 over 200).
  const top = Math.max(...vals.filter(isNum), isNum(target) ? target : 0) || 100; // never [0, 0]
  const interval = niceStep((top * 1.08) / 5);
  const max = Math.ceil((top * 1.08) / interval) * interval;

  const tooltip = axisTooltip(tokens, (params) => {
    const ps = Array.isArray(params) ? params : [params];
    const i = ps[0]?.dataIndex;
    const row = rows[i];
    if (!row) return '';
    const g = goalOf(row);
    const goalRow = isNum(g) ? tipRow(dot(tokens.ink2), weekly ? 'Avg goal' : 'Goal', `${fmtG(g)} g`) : '';
    const v = vals[i];
    if (v == null) {
      const why = !weekly && row.status === 'incomplete' ? NOTE.incomplete : NOTE.missing;
      return head(tokens, headText(row, weekly)) + goalRow + note(tokens, why);
    }
    const suffix = !weekly && row.status === 'partial' ? ' so far' : '';
    const label = weekly ? 'Avg protein' : 'Protein';
    let foot = '';
    if (weekly) foot = note(tokens, `${row.days_logged} ${row.days_logged === 1 ? 'day' : 'days'} logged`);
    else if (row.status === 'incomplete') foot = note(tokens, NOTE.incomplete);
    return head(tokens, headText(row, weekly)) + tipRow(dot(accent), label, `${fmtInt(v)} g${suffix}`) + goalRow + foot;
  });

  return {
    ...frame(tokens, opts),
    grid: grid({ top: 16 }),
    tooltip,
    xAxis: categoryAxis(tokens, rows.map((r) => catOf(r, weekly))),
    yAxis: valueAxis(tokens, { min: 0, max, interval, axisLabel: { formatter: (v) => fmtInt(v) } }),
    series: [bars],
  };
}
