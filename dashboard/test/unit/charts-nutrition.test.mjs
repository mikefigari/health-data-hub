// T7 spec: calories-by-macro, protein-vs-goal and logging-calendar option builders.
// All pure (no window/document at import). Builder signature: (data, tokens, {range, reducedMotion}).
//
// Exports pinned:
//   charts/nutrition.mjs: caloriesOption, proteinOption, caloriesSubtitle(data, {range}) -> string,
//                         proteinCaption(data) -> 'In range N of M days' (T16, D12), proteinHero(data) -> {value:'37%', unit, caption}
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
import { caloriesOption, proteinOption, caloriesSubtitle, proteinCaption, proteinHero } from '../../public/js/charts/nutrition.mjs';
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

// ---------- (e) protein (D12: percent of calories vs the 35-40 band, T16) ----------
const BAND = [data.goals.protein_pct_min, data.goals.protein_pct_max];
const rowsFor = (d, weekly) => (weekly ? d.nutrition.weeks : d.nutrition.days);
const pctOfRow = (r, weekly) => (weekly ? r.avg_protein_pct : r.protein_pct);
const markAreaOf = (opt) => arr(opt.series).find((s) => s.markArea)?.markArea;
const noBar = (p) => val(p) == null || num(p) === 0;

test('proteinOption: bars are percent; in-band bars full accent, others accent at 0.45', () => {
  const opt = proteinOption(data, tk, { range: 30 });
  const bars = series(opt, 'protein');
  assert.ok(bars, 'series named protein');
  assert.equal(bars.type, 'bar');
  assert.ok(bars.barMaxWidth <= 28);
  assert.equal(bars.data.length, data.nutrition.days.length);
  const firstBar = data.nutrition.days.findIndex((d) => d.status === 'logged');
  assert.ok(!isZeroRadius(radiusOf(bars, firstBar)), 'rounded bars');
  let inBand = 0;
  let outBand = 0;
  data.nutrition.days.forEach((d, i) => {
    if (d.status === 'missing' || d.status === 'incomplete') {
      assert.ok(noBar(bars.data[i]), `no bar ${d.day}`);
      return;
    }
    assert.ok(Math.abs(num(bars.data[i]) - d.protein_pct) < 0.06, `bar is protein_pct ${d.day}: ${num(bars.data[i])} vs ${d.protein_pct}`);
    assert.equal(rgbHex(colorOf(bars, i)), tk.protein.toLowerCase(), `accent hue ${d.day}`);
    const expected = (d.protein_in_range ? 1 : 0.45) * (d.status === 'partial' ? 0.6 : 1);
    if (d.protein_in_range) inBand++;
    else outBand++;
    assert.ok(Math.abs(opacityOf(bars, i) - expected) < 0.02, `opacity ${d.day} (${d.status}, in range ${d.protein_in_range}): ${opacityOf(bars, i)} vs ${expected}`);
  });
  assert.ok(inBand > 0 && outBand > 0, 'demo has in-band and out-of-band days');
  assert.ok(data.nutrition.days.some((d) => d.status === 'partial'), 'demo has a partial day');
});

test('proteinOption: weekly ranges (90, 365) plot avg_protein_pct per week', () => {
  for (const r of [90, 365]) {
    const opt = proteinOption(D[r], tk, { range: r });
    const weeks = D[r].nutrition.weeks;
    assert.equal(arr(opt.xAxis)[0].data.length, weeks.length);
    const bars = series(opt, 'protein');
    weeks.forEach((w, i) => {
      if (w.days_logged > 0 && w.avg_protein_pct != null) {
        assert.ok(Math.abs(num(bars.data[i]) - w.avg_protein_pct) < 0.06, `week ${w.week_start}`);
      } else {
        assert.ok(noBar(bars.data[i]), `no bar week ${w.week_start}`);
      }
    });
  }
});

test('proteinOption: markArea band min..max in a 12-18% accent, labelled "35–40%", no gram line', () => {
  for (const r of [30, 90]) {
    const opt = proteinOption(D[r], tk, { range: r });
    const ma = markAreaOf(opt);
    assert.ok(ma, `markArea present at ${r}`);
    const [a, b] = arr(ma.data)[0];
    assert.deepEqual([a.yAxis, b.yAxis].sort((x, y) => x - y), BAND);
    const fill = ma.itemStyle?.color ?? a.itemStyle?.color;
    assert.equal(rgbHex(fill), tk.protein.toLowerCase(), 'band uses the protein accent');
    const al = alphaOf(fill);
    assert.ok(al >= 0.115 && al <= 0.185, `band alpha ${al}`);
    assert.ok(JSON.stringify(ma).includes('35–40%'), 'label 35–40%');
    assert.ok(!arr(opt.series).some((s) => s.markLine), 'no goal markLine');
    assert.ok(!/\d g\b/.test(JSON.stringify(ma)), 'no gram label');
  }
});

test('proteinOption: y-axis 0..max(50, ceil(dataMax/10)*10+10), 10% ticks, % labels', () => {
  for (const r of [7, 30, 90, 365]) {
    const opt = proteinOption(D[r], tk, { range: r });
    const weekly = r > 30;
    const vals = rowsFor(D[r], weekly)
      .filter((x) => (weekly ? x.days_logged > 0 : x.status !== 'missing' && x.status !== 'incomplete'))
      .map((x) => pctOfRow(x, weekly))
      .filter((v) => v != null);
    const top = Math.max(...vals);
    const y = arr(opt.yAxis)[0];
    assert.equal(y.min, 0);
    assert.equal(y.max, Math.max(50, Math.ceil(top / 10) * 10 + 10), `max at range ${r} (data max ${top})`);
    assert.equal(y.interval, 10);
    assert.equal(y.axisLabel.formatter(30), '30%');
  }
});

test('proteinOption: tooltip shows pct, grams and kcal, and the band status', () => {
  const opt = proteinOption(data, tk, { range: 30 });
  assertTooltip(opt.tooltip, 'axis', 'protein');
  assertFrame(opt, 'protein');
  assert.equal(proteinOption(data, tk, { range: 30, reducedMotion: true }).animation, false);
  const seen = new Set();
  data.nutrition.days.forEach((d, i) => {
    if (d.status !== 'logged') return;
    const text = tipText(opt, i);
    const pctOk = text.includes(`${Math.round(d.protein_pct)}%`) || text.includes(`${d.protein_pct.toFixed(1)}%`);
    assert.ok(pctOk, `pct in tooltip ${d.day}: ${text}`);
    assert.match(text, /protein/i);
    assert.ok(text.includes(`${fmtInt(d.calories)} kcal`), `kcal in tooltip: ${text}`);
    assert.ok(text.includes(`${Math.round(d.protein_g)} g`) || text.includes(`${d.protein_g.toFixed(1)} g`), `grams in tooltip: ${text}`);
    let status = 'Above range';
    if (d.protein_in_range) status = 'In range';
    else if (d.protein_pct < BAND[0]) status = 'Below range';
    assert.ok(text.includes(status), `${status} for ${d.day} (${d.protein_pct}): ${text}`);
    seen.add(status);
  });
  assert.ok(seen.has('In range') && seen.has('Below range'), `demo covers in/below: ${[...seen]}`);
  const wopt = proteinOption(D[90], tk, { range: 90 });
  assertTooltip(wopt.tooltip, 'axis', 'protein weekly');
  const wi = D[90].nutrition.weeks.findIndex((x) => x.days_logged > 0 && x.avg_protein_pct != null);
  const wp = D[90].nutrition.weeks[wi].avg_protein_pct;
  const wt = tipText(wopt, wi);
  assert.ok(wt.includes(`${Math.round(wp)}%`) || wt.includes(`${wp.toFixed(1)}%`), wt);
});

test('proteinCaption / proteinHero: average % and "In range N of M days"', () => {
  for (const d of [data, D[7], D[90]]) {
    const s = d.nutrition.summary;
    const caption = `In range ${s.protein_days_in_range} of ${s.days_logged} days`;
    assert.equal(proteinCaption(d), caption);
    const h = proteinHero(d);
    assert.equal(h.value, `${Math.round(s.avg_protein_pct)}%`);
    assert.equal(h.caption, caption);
    assert.ok(!/ g\b/.test(`${h.value} ${h.unit}`), 'no grams in hero');
  }
});

test('no gram goal / "goal met" text in any protein option or caption for demo data', () => {
  const BAD = /\sg$|goal met|Goal \d+ g|of \d+ g/i;
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) Object.values(v).forEach(walk);
  };
  for (const r of [7, 30, 90, 365]) {
    const opt = proteinOption(D[r], tk, { range: r });
    walk(JSON.parse(JSON.stringify(opt)));
    const y = arr(opt.yAxis)[0];
    for (const v of [0, 10, 20, 30, 40, 50]) strings.push(String(y.axisLabel.formatter(v)));
    const n = D[r].nutrition[r > 30 ? 'weeks' : 'days'].length;
    for (let i = 0; i < n; i++) {
      strings.push(String(opt.tooltip.formatter(axisParams(opt, i))).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
    }
    strings.push(proteinCaption(D[r]), proteinHero(D[r]).caption);
  }
  for (const s of strings) assert.ok(!BAD.test(s.trim()), `gram/goal-met text: ${s}`);
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

// ---------- (g) today protein ring: band target (T16) ----------
// Band mode API pinned here: ringOption/ringLabel take d = { value: pct, min, max } (percent of calories).
// Band mode is active when d.min and d.max are numbers; the calorie ring keeps { value, goal }.
import { ringOption, ringLabel } from '../../public/js/charts/rings.mjs';

const ringGauges = (opt) => arr(opt.series).filter((s) => s.type === 'gauge');

test('protein ring: max = band max, fills to min(pct, max), never draws the over lap', () => {
  const [lo, hi] = BAND;
  const logged = { value: data.today_rings.protein_pct, min: lo, max: hi };
  const g = ringGauges(ringOption(logged, tk, { accent: 'protein' }));
  assert.equal(g.length, 1);
  assert.equal(g[0].max, hi);
  assert.ok(Math.abs(g[0].data[0].value - Math.min(logged.value, hi)) < 1e-9);
  assert.equal(rgbHex(g[0].progress.itemStyle.color), tk.protein.toLowerCase());

  const above = ringGauges(ringOption({ value: 52, min: lo, max: hi }, tk, { accent: 'protein' }));
  assert.equal(above.length, 1, 'no second lap above the band');
  assert.equal(above[0].data[0].value, hi);
  assert.ok(!JSON.stringify(above).toLowerCase().includes(tk.over.toLowerCase()), 'over color unused');

  const zero = ringGauges(ringOption({ value: 0, min: lo, max: hi }, tk, { accent: 'protein' }));
  assert.equal(zero.length, 1);
  assert.equal(zero[0].data[0].value, 0);
});

test('protein ring: centre label is pct, "of calories", "Target 35\u201340%"', () => {
  const [lo, hi] = BAND;
  const p = data.today_rings.protein_pct;
  assert.deepEqual(ringLabel({ value: p, min: lo, max: hi }, { unit: '%' }), {
    big: `${Math.round(p)}%`,
    small: 'of calories',
    caption: 'Target 35\u201340%',
  });
  assert.equal(ringLabel({ value: 37.2, min: lo, max: hi }).big, '37%');
  assert.equal(ringLabel({ value: 0, min: lo, max: hi }).big, '0%');
  assert.equal(ringLabel({ value: 0, min: lo, max: hi }).caption, 'Target 35\u201340%');
});

test('calorie ring is unchanged: goal-based label and over lap', () => {
  assert.deepEqual(ringLabel({ value: 900, goal: 2620 }, { unit: 'kcal' }), { big: '900', small: 'of 2,620 kcal', caption: '1,720 left' });
  assert.equal(ringGauges(ringOption({ value: 3000, goal: 2620 }, tk, { accent: 'calories' })).length, 2);
});
