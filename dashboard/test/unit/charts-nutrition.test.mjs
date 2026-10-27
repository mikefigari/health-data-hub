// T7 spec: calories-by-macro, protein-vs-goal and logging-calendar option builders.
// All pure (no window/document at import). Builder signature: (data, tokens, {range, reducedMotion}).
//
// Exports pinned:
//   charts/nutrition.mjs: caloriesOption, proteinOption, caloriesSubtitle(data, {range}) -> string,
//                         proteinCaption(data) -> 'Goal met N of M days' (from nutrition.summary)
//   charts/calendar.mjs:  calendarOption(data, tokens, {width=358, reducedMotion}),
//                         calendarCellSize(widthPx) -> number (cell pitch in px),
//                         calendarLegend(tokens) -> [{label, color}, ...]
//
// Data shape assumptions (documented, not private internals):
//  - range 7/30: one category per nutrition.days entry; range 90/365: one per nutrition.weeks entry.
//  - Series names: 'protein','carbs','fat','other' (stacked bars, in that order), 'goal' (step line),
//    'placeholder' (bar at goal height for missing/incomplete days). Data items may be plain numbers or
//    {value, itemStyle}; macro series hold kcal (kcal_protein ... kcal_other, or avg_kcal_* for weeks).
//  - On placeholder days (missing/incomplete) the four macro series hold 0/null and 'placeholder' holds goal_calories.
//  - Tooltip formatter is called with an axis-trigger params ARRAY, one entry per series:
//    {seriesName, seriesType, seriesIndex, dataIndex, axisValue, value, data, marker}.
//    The calendar tooltip is trigger:'item', called with ONE params object {value:[day,status], data, dataIndex, marker}.
//  - Calendar heatmap data items are [day, status] (or {value:[day,status], itemStyle}) with status in
//    under|over|today|none; the 'today' cell's item carries its own outline (borderColor != card, borderWidth >= 2).
//  - Calendar fit: the calendar fills the card width (opts.width, default 358); pitch = cellSize + gap (borderWidth).
//    The real range 2026-04-28..2026-10-26 spans 26 or 27 week columns depending on firstDay; the test computes it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { TOKENS, fmtInt } from '../../public/js/core.mjs';
import { buildDashboard } from '../../src/aggregate.mjs';
import { demoInputs } from '../../src/demo.mjs';
import { caloriesOption, proteinOption, caloriesSubtitle, proteinCaption } from '../../public/js/charts/nutrition.mjs';
import { calendarOption, calendarCellSize, calendarLegend } from '../../public/js/charts/calendar.mjs';

const TODAY = '2026-10-26';
const mk = (rangeDays) => buildDashboard({ ...demoInputs(TODAY), rangeDays });
const D = { 7: mk(7), 30: mk(30), 90: mk(90), 365: mk(365) };
const data = D[30];
const tk = TOKENS.light;

const arr = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const series = (opt, name) => arr(opt.series).find((s) => s.name === name);
const isObj = (p) => p !== null && typeof p === 'object' && !Array.isArray(p);
const val = (p) => (isObj(p) ? p.value : p);
const num = (p) => Number(val(p)) || 0;
const itemOf = (p) => (isObj(p) ? p : {});

function alphaOf(c) {
  if (typeof c !== 'string') return 1;
  let m = /^#([0-9a-f]{8})$/i.exec(c);
  if (m) return parseInt(m[1].slice(6), 16) / 255;
  m = /^#([0-9a-f]{4})$/i.exec(c);
  if (m) return parseInt(m[1][3] + m[1][3], 16) / 255;
  m = /^(?:rgba|hsla)\(([^)]*)\)$/i.exec(c);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  }
  return 1;
}
function rgbHex(c) {
  let m = /^#([0-9a-f]{6})/i.exec(c);
  if (m) return `#${m[1].toLowerCase()}`;
  m = /^rgba?\(([^)]*)\)$/i.exec(c);
  if (m) {
    const [r, g, b] = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  return c;
}
// Color of data item i of series s (item style wins over series style).
const colorOf = (s, i) => itemOf(s.data[i]).itemStyle?.color ?? s.itemStyle?.color;
// Effective opacity = itemStyle.opacity * color alpha.
const opacityOf = (s, i) => {
  const it = itemOf(s.data[i]).itemStyle || {};
  const op = it.opacity ?? s.itemStyle?.opacity ?? 1;
  return op * alphaOf(colorOf(s, i));
};
const radiusOf = (s, i) => itemOf(s.data[i]).itemStyle?.borderRadius ?? s.itemStyle?.borderRadius;
const isZeroRadius = (r) => r === undefined || r === 0 || (Array.isArray(r) && r.every((x) => x === 0));

const MACROS = ['protein', 'carbs', 'fat', 'other'];
const KCAL_KEY = { protein: 'kcal_protein', carbs: 'kcal_carbs', fat: 'kcal_fat', other: 'kcal_other' };
const AVG_KEY = { protein: 'avg_kcal_protein', carbs: 'avg_kcal_carbs', fat: 'avg_kcal_fat', other: 'avg_kcal_other' };

// Build the axis-tooltip params array for data index i.
function axisParams(opt, i) {
  const cats = arr(opt.xAxis)[0].data;
  return arr(opt.series).map((s, seriesIndex) => ({
    seriesName: s.name,
    seriesType: s.type,
    seriesIndex,
    dataIndex: i,
    axisValue: cats[i],
    value: val(s.data[i]),
    data: s.data[i],
    marker: '',
  }));
}
const tipText = (opt, i) => String(opt.tooltip.formatter(axisParams(opt, i)));

function assertTooltip(t, trigger, label) {
  assert.equal(t.trigger, trigger, `${label} tooltip trigger`);
  assert.ok(String(t.triggerOn).includes('click'), `${label} triggerOn includes click`);
  assert.equal(t.confine, true, `${label} confine`);
  assert.equal(typeof t.formatter, 'function', `${label} formatter`);
}
function assertFrame(opt, label) {
  assert.ok(opt.animationDuration >= 600 && opt.animationDuration <= 900, `${label} animationDuration`);
  assert.equal(opt.animationEasing, 'cubicOut', `${label} easing`);
}

// ---------- (a) data source by range ----------
test('caloriesOption: ranges 7 and 30 use nutrition.days, one category per day', () => {
  for (const r of [7, 30]) {
    const opt = caloriesOption(D[r], tk, { range: r });
    const cats = arr(opt.xAxis)[0].data;
    assert.equal(cats.length, D[r].nutrition.days.length, `range ${r}`);
    assert.equal(D[r].nutrition.days.length, r);
    for (const m of MACROS) assert.equal(series(opt, m).data.length, cats.length, `${m} length`);
    assert.ok(!/weekly average/i.test(caloriesSubtitle(D[r], { range: r })), `range ${r} subtitle`);
  }
});

test('caloriesOption: ranges 90 and 365 use nutrition.weeks and say "weekly average"', () => {
  for (const r of [90, 365]) {
    const opt = caloriesOption(D[r], tk, { range: r });
    const cats = arr(opt.xAxis)[0].data;
    assert.equal(cats.length, D[r].nutrition.weeks.length, `range ${r}`);
    assert.ok(D[r].nutrition.weeks.length > 10);
    assert.match(caloriesSubtitle(D[r], { range: r }), /weekly average/i);
    // weekly values are the avg_kcal_* fields
    const w = D[r].nutrition.weeks.findIndex((x) => x.days_logged > 0);
    for (const m of MACROS) assert.equal(num(series(opt, m).data[w]), D[r].nutrition.weeks[w][AVG_KEY[m]], `${m} week ${w}`);
  }
});

// ---------- (b) stacked bars ----------
test('caloriesOption: four stacked bar series in macro accents, other in ink3', () => {
  const opt = caloriesOption(data, tk, { range: 30 });
  const bars = arr(opt.series).filter((s) => MACROS.includes(s.name));
  assert.deepEqual(bars.map((s) => s.name), MACROS);
  const stacks = new Set(bars.map((s) => s.stack));
  assert.equal(stacks.size, 1);
  assert.ok([...stacks][0], 'shared stack key');
  for (const s of bars) {
    assert.equal(s.type, 'bar');
    assert.ok(s.barMaxWidth <= 28 && s.barMaxWidth > 0, `${s.name} barMaxWidth`);
  }
  const logged = data.nutrition.days.findIndex((d) => d.status === 'logged');
  assert.equal(rgbHex(colorOf(series(opt, 'protein'), logged)), tk.protein.toLowerCase());
  assert.equal(rgbHex(colorOf(series(opt, 'carbs'), logged)), tk.carbs.toLowerCase());
  assert.equal(rgbHex(colorOf(series(opt, 'fat'), logged)), tk.fat.toLowerCase());
  assert.equal(rgbHex(colorOf(series(opt, 'other'), logged)), tk.ink3.toLowerCase());
  assert.equal(alphaOf(colorOf(series(opt, 'protein'), logged)), 1);
});

test('caloriesOption: values are the kcal parts; only the top non-zero segment is rounded', () => {
  for (const r of [30, 90]) {
    const opt = caloriesOption(D[r], tk, { range: r });
    const rows = r === 30 ? D[30].nutrition.days : D[90].nutrition.weeks;
    const keys = r === 30 ? KCAL_KEY : AVG_KEY;
    let checked = 0;
    rows.forEach((row, i) => {
      const vals = MACROS.map((m) => num(series(opt, m).data[i]));
      if (r === 30 && row.status === 'logged') {
        MACROS.forEach((m, k) => assert.equal(vals[k], row[keys[m]], `${m} ${i}`));
      }
      const topIdx = vals.map((v) => v > 0).lastIndexOf(true);
      if (topIdx < 0) return;
      MACROS.forEach((m, k) => {
        const rad = radiusOf(series(opt, m), i);
        if (k === topIdx) assert.deepEqual(rad, [6, 6, 0, 0], `${m} top segment day ${i}`);
        else assert.ok(isZeroRadius(rad), `${m} not top on ${i}: ${JSON.stringify(rad)}`);
      });
      checked++;
    });
    assert.ok(checked > 5, 'checked several bars');
  }
});

// ---------- (c) goal line ----------
test('caloriesOption: goal is a dashed ink2 step line without symbols', () => {
  const opt = caloriesOption(data, tk, { range: 30 });
  const g = series(opt, 'goal');
  assert.ok(g, 'series named goal');
  assert.equal(g.type, 'line');
  assert.equal(g.step, 'middle');
  assert.equal(g.lineStyle.type, 'dashed');
  assert.equal(rgbHex(g.lineStyle.color ?? g.itemStyle?.color), tk.ink2.toLowerCase());
  assert.ok(g.symbol === 'none' || g.showSymbol === false, 'no symbols');
  assert.equal(g.data.length, data.nutrition.days.length);
  assert.equal(num(g.data[0]), data.nutrition.days[0].goal_calories);
  const w = caloriesOption(D[90], tk, { range: 90 });
  const wi = D[90].nutrition.weeks.findIndex((x) => x.avg_goal_calories != null);
  assert.equal(num(series(w, 'goal').data[wi]), D[90].nutrition.weeks[wi].avg_goal_calories);
});

// ---------- (d) placeholders and partial ----------
test('caloriesOption: missing and incomplete days get a faint placeholder bar at goal height', () => {
  const opt = caloriesOption(data, tk, { range: 30 });
  const ph = series(opt, 'placeholder');
  assert.ok(ph, 'series named placeholder');
  assert.equal(ph.type, 'bar');
  const days = data.nutrition.days;
  let n = 0;
  days.forEach((d, i) => {
    if (d.status === 'missing' || d.status === 'incomplete') {
      n++;
      assert.equal(num(ph.data[i]), d.goal_calories, `placeholder height ${d.day}`);
      for (const m of MACROS) assert.equal(num(series(opt, m).data[i]), 0, `${m} empty on ${d.day}`);
      const st = { ...ph.itemStyle, ...itemOf(ph.data[i]).itemStyle };
      assert.ok(st.decal || opacityOf(ph, i) <= 0.15, `placeholder faint on ${d.day}`);
    } else {
      assert.equal(num(ph.data[i]), 0, `no placeholder on ${d.day}`);
    }
  });
  assert.ok(n >= 3, 'demo has missing + incomplete days');
});

test('caloriesOption: tooltip labels Not logged / Marked incomplete / "so far"', () => {
  const opt = caloriesOption(data, tk, { range: 30 });
  const days = data.nutrition.days;
  const at = (status) => days.findIndex((d) => d.status === status);
  assert.match(tipText(opt, at('missing')), /Not logged/);
  assert.match(tipText(opt, at('incomplete')), /Marked incomplete/);
  const logged = tipText(opt, at('logged'));
  assert.ok(!/so far|Not logged|Marked incomplete/.test(logged), 'logged day has no suffix');
  const pi = at('partial');
  assert.equal(pi, days.length - 1);
  assert.match(tipText(opt, pi), /so far/);
});

test('caloriesOption: partial day renders at 0.6 opacity, logged days at full', () => {
  const opt = caloriesOption(data, tk, { range: 30 });
  const days = data.nutrition.days;
  const pi = days.findIndex((d) => d.status === 'partial');
  const li = days.findIndex((d) => d.status === 'logged');
  for (const m of MACROS) {
    const s = series(opt, m);
    if (num(s.data[pi]) > 0) assert.ok(Math.abs(opacityOf(s, pi) - 0.6) < 0.02, `${m} partial opacity ${opacityOf(s, pi)}`);
    if (num(s.data[li]) > 0) assert.ok(opacityOf(s, li) > 0.98, `${m} logged opacity`);
  }
  assert.ok(num(series(opt, 'protein').data[pi]) > 0);
});

// ---------- (g) tooltip content, frame ----------
test('caloriesOption: tooltip shows kcal, P/C/F grams and goal', () => {
  const opt = caloriesOption(data, tk, { range: 30 });
  assertTooltip(opt.tooltip, 'axis', 'calories');
  const i = data.nutrition.days.findIndex((d) => d.status === 'logged');
  const d = data.nutrition.days[i];
  const text = tipText(opt, i);
  assert.ok(text.includes(fmtInt(d.calories)), `kcal ${fmtInt(d.calories)} in: ${text}`);
  assert.ok(/kcal/.test(text), 'unit kcal');
  assert.ok(text.includes(fmtInt(d.goal_calories)), 'goal');
  for (const g of [d.protein_g, d.carbs_g, d.fat_g]) {
    assert.ok(text.includes(String(Math.round(g))) || text.includes(g.toFixed(1)), `grams ${g} in: ${text}`);
  }
  assertFrame(opt, 'calories');
  assert.equal(arr(opt.grid)[0].containLabel, true);
  assert.equal(caloriesOption(data, tk, { range: 30, reducedMotion: true }).animation, false);
  const wopt = caloriesOption(D[90], tk, { range: 90 });
  assertTooltip(wopt.tooltip, 'axis', 'calories weekly');
  const wi = D[90].nutrition.weeks.findIndex((x) => x.days_logged > 0);
  assert.ok(tipText(wopt, wi).includes(fmtInt(D[90].nutrition.weeks[wi].avg_calories)));
});

// ---------- (e) protein ----------
test('proteinOption: bars meeting goal are full accent, others accent at 0.45', () => {
  const opt = proteinOption(data, tk, { range: 30 });
  const bars = series(opt, 'protein');
  assert.ok(bars, 'series named protein');
  assert.equal(bars.type, 'bar');
  assert.ok(bars.barMaxWidth <= 28);
  assert.equal(bars.data.length, data.nutrition.days.length);
  let met = 0;
  let notMet = 0;
  data.nutrition.days.forEach((d, i) => {
    if (d.status !== 'logged') return;
    const c = colorOf(bars, i);
    assert.equal(rgbHex(c), tk.protein.toLowerCase(), `accent hue ${d.day}`);
    if (d.protein_g >= d.goal_protein_g) {
      met++;
      assert.ok(opacityOf(bars, i) > 0.98, `met full ${d.day}`);
    } else {
      notMet++;
      assert.ok(Math.abs(opacityOf(bars, i) - 0.45) < 0.02, `not met 0.45 ${d.day}: ${opacityOf(bars, i)}`);
    }
    assert.equal(num(bars.data[i]), d.protein_g);
  });
  assert.ok(met > 0 && notMet > 0, 'demo has both met and unmet days');
});

test('proteinOption: markLine at the goal labelled "180 g"; weekly ranges use weeks', () => {
  const opt = proteinOption(data, tk, { range: 30 });
  const s = arr(opt.series).find((x) => x.markLine);
  assert.ok(s, 'a series carries the markLine');
  const ml = s.markLine;
  assert.ok(JSON.stringify(ml.data).includes('180'), 'at y = 180');
  assert.equal(arr(ml.data)[0].yAxis ?? arr(ml.data)[0].value, 180);
  assert.ok(JSON.stringify(ml).includes('180 g'), 'label 180 g');
  const w = proteinOption(D[90], tk, { range: 90 });
  assert.equal(arr(w.xAxis)[0].data.length, D[90].nutrition.weeks.length);
  assertTooltip(opt.tooltip, 'axis', 'protein');
  assertFrame(opt, 'protein');
  assert.equal(proteinOption(data, tk, { range: 30, reducedMotion: true }).animation, false);
});

test('proteinOption: tooltip shows grams and goal', () => {
  const opt = proteinOption(data, tk, { range: 30 });
  const i = data.nutrition.days.findIndex((d) => d.status === 'logged');
  const d = data.nutrition.days[i];
  const text = tipText(opt, i);
  assert.ok(text.includes(String(Math.round(d.protein_g))) || text.includes(d.protein_g.toFixed(1)), text);
  assert.ok(text.includes('180'), 'goal in tooltip');
});

test('proteinCaption: "Goal met N of M days" from the summary', () => {
  const s = data.nutrition.summary;
  assert.equal(proteinCaption(data), `Goal met ${s.protein_days_met} of ${s.days_logged} days`);
  const s7 = D[7].nutrition.summary;
  assert.equal(proteinCaption(D[7]), `Goal met ${s7.protein_days_met} of ${s7.days_logged} days`);
});

// ---------- (f) calendar ----------
const cal = (opt) => arr(opt.calendar)[0];
const hm = (opt) => arr(opt.series).find((s) => s.type === 'heatmap');
const pieces = (opt) => arr(opt.visualMap)[0].pieces;
const piece = (opt, key) => pieces(opt).find((p) => p.value === key);

test('calendarOption: calendar spans calendar.start..end with a heatmap of statuses', () => {
  const opt = calendarOption(data, tk, {});
  assert.deepEqual(cal(opt).range, [data.calendar.start, data.calendar.end]);
  const s = hm(opt);
  assert.ok(s, 'heatmap series');
  assert.equal(s.coordinateSystem, 'calendar');
  assert.equal(s.data.length, data.calendar.days.length);
  data.calendar.days.forEach((d, i) => {
    const v = val(s.data[i]);
    assert.deepEqual([v[0], v[1]], [d.day, d.status], `cell ${d.day}`);
  });
  assertFrame(opt, 'calendar');
  assert.equal(calendarOption(data, tk, { reducedMotion: true }).animation, false);
});

test('calendarOption: rounded cells with card-colored gaps', () => {
  const opt = calendarOption(data, tk, {});
  const st = { ...cal(opt).itemStyle, ...hm(opt).itemStyle };
  assert.ok(st.borderRadius >= 3 || (Array.isArray(st.borderRadius) && Math.min(...st.borderRadius) >= 3), `radius ${st.borderRadius}`);
  assert.ok(st.borderWidth >= 2, `gap ${st.borderWidth}`);
  assert.equal(rgbHex(st.borderColor), tk.card.toLowerCase());
  const dark = calendarOption(data, TOKENS.dark, {});
  const dst = { ...cal(dark).itemStyle, ...hm(dark).itemStyle };
  assert.equal(rgbHex(dst.borderColor), TOKENS.dark.card.toLowerCase());
});

test('calendarOption: categorical visualMap pieces and an outlined today cell', () => {
  const opt = calendarOption(data, tk, {});
  const vm = arr(opt.visualMap)[0];
  assert.equal(vm.type, 'piecewise');
  assert.equal(rgbHex(piece(opt, 'under').color), tk.calories.toLowerCase());
  assert.equal(rgbHex(piece(opt, 'over').color), tk.over.toLowerCase());
  assert.equal(rgbHex(piece(opt, 'none').color), tk.track.toLowerCase());
  assert.ok(piece(opt, 'today'), 'today piece');
  const i = data.calendar.days.findIndex((d) => d.day === data.today);
  const it = itemOf(hm(opt).data[i]);
  assert.ok(it.itemStyle?.borderColor, 'today item has its own outline');
  assert.notEqual(rgbHex(it.itemStyle.borderColor), tk.card.toLowerCase());
  assert.ok(it.itemStyle.borderWidth >= 2);
});

test('calendarLegend: At or under goal / Over goal / Not logged', () => {
  const lg = calendarLegend(tk);
  assert.deepEqual(lg.map((x) => x.label), ['At or under goal', 'Over goal', 'Not logged']);
  assert.deepEqual(lg.map((x) => rgbHex(x.color)), [tk.calories, tk.over, tk.track].map((c) => c.toLowerCase()));
});

test('calendarOption: tooltip opens on click and confines', () => {
  const opt = calendarOption(data, tk, {});
  assertTooltip(opt.tooltip, 'item', 'calendar');
  const d = data.calendar.days.find((x) => x.status === 'over');
  const text = String(opt.tooltip.formatter({ value: [d.day, d.status], data: [d.day, d.status], dataIndex: 0, marker: '' }));
  const [, m, dd] = d.day.split('-');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
  assert.ok(text.includes(`${mon} ${Number(dd)}`), text);
});

// Week columns the calendar needs for start..end given firstDay (0 = Sunday).
function weekColumns(start, end, firstDay = 0) {
  const ts = (s) => Date.parse(`${s}T00:00:00Z`);
  const dow = new Date(ts(start)).getUTCDay();
  const lead = (dow - firstDay + 7) % 7;
  const span = Math.round((ts(end) - ts(start)) / 86400000) + 1;
  return Math.ceil((lead + span) / 7);
}

test('calendarCellSize: the ~26-week calendar fits 358 px (and other widths) without overflow', () => {
  const opt = calendarOption(data, tk, { width: 358 });
  const c = cal(opt);
  const cell = Array.isArray(c.cellSize) ? c.cellSize[0] : c.cellSize;
  assert.equal(cell, calendarCellSize(358));
  const gap = { ...c.itemStyle, ...hm(opt).itemStyle }.borderWidth;
  const cols = weekColumns(data.calendar.start, data.calendar.end, c.firstDay ?? 0);
  assert.ok(cols >= 26 && cols <= 27, `columns ${cols}`);
  const margins = (Number(c.left) || 0) + (Number(c.right) || 0);
  assert.ok(cols * (cell + gap) + margins <= 358, `${cols} cols * (${cell}+${gap}) + ${margins} > 358`);
  assert.ok(cell >= 6, `cells stay legible: ${cell}`);
  for (const w of [320, 358, 420, 600, 900]) {
    const s = calendarCellSize(w);
    assert.ok(Number.isFinite(s) && s > 0, `size at ${w}`);
    assert.ok(cols * (s + gap) <= w, `fits at ${w}: ${cols} * (${s}+${gap})`);
    assert.ok(calendarCellSize(w + 40) >= s, 'monotonic');
  }
});
