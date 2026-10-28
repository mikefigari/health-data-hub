// T6 spec: pure ECharts option builders for the today rings, weight trend and FTP cards.
// Signatures (all pure, no window/document at import):
//   ringOption({value, goal}, tokens, {accent, reducedMotion})   tokens = TOKENS.light | TOKENS.dark
//   ringLabel({value, goal}, {unit='kcal'}) -> {big, small, caption}
//   weightOption(data, tokens, {range, reducedMotion})           data = full /api/dashboard payload
//   weightHero(data) -> {value, unit, caption};  ftpOption(data, tokens, opts);  ftpHero(data)
// Series naming: weight -> 'scale' (scatter), 'trend' (line), 'plan pace' (dashed line);
//   ftp -> 'FTP' (step line), 'W/kg' (line, right axis), 'tests' (scatter, one point per test day).
// Weight/plan points are [ 'YYYY-MM-DD', kg ] pairs on a time x-axis.
import test from 'node:test';
import assert from 'node:assert/strict';

import { TOKENS, fmtKg } from '../../public/js/core.mjs';
import { buildDashboard } from '../../src/aggregate.mjs';
import { demoInputs } from '../../src/demo.mjs';
import { ringOption, ringLabel } from '../../public/js/charts/rings.mjs';
import { weightOption, weightHero } from '../../public/js/charts/weight.mjs';
import { ftpOption, ftpHero } from '../../public/js/charts/ftp.mjs';

const data = buildDashboard(demoInputs('2026-10-26'));
const tk = TOKENS.light;
const MINUS = '−';

const arr = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const seriesOf = (opt, type, name) =>
  arr(opt.series).find((s) => s.type === type && (name === undefined || s.name === name));
const pt = (p) => (Array.isArray(p) ? p : p.value);

// Alpha of '#rrggbbaa', '#rgba', or rgba()/hsla(); 1 for opaque colors.
function alphaOf(c) {
  assert.equal(typeof c, 'string', `color expected, got ${JSON.stringify(c)}`);
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
// Opaque base of a color, as lowercase #rrggbb (supports #rrggbb[aa] and rgba()).
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
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function assertCommon(opt, label) {
  assert.ok(opt.animationDuration >= 600 && opt.animationDuration <= 900, `${label} animationDuration`);
  assert.equal(opt.animationEasing, 'cubicOut', `${label} easing`);
  if (opt.grid) assert.equal(arr(opt.grid)[0].containLabel, true, `${label} grid.containLabel`);
}
function assertAxes(opt, tokens, label) {
  const ys = arr(opt.yAxis);
  const xs = arr(opt.xAxis);
  assert.ok(ys.length >= 1 && xs.length >= 1, `${label} axes`);
  assert.equal(arr(opt.grid)[0].containLabel, true, `${label} grid.containLabel`);
  for (const a of [...xs, ...ys]) {
    assert.equal(a.axisLine?.show, false, `${label} axisLine hidden`);
    assert.equal(a.axisLabel?.color, tokens.ink2, `${label} label color ink2`);
  }
  assert.equal(ys[0].splitLine?.lineStyle?.color, tokens.grid, `${label} split lines in grid token`);
}

// ---------- (a) rings ----------
test('ringOption: gauge ring with rounded progress and faint track', () => {
  const opt = ringOption({ value: 1840, goal: 2620 }, tk, { accent: 'calories' });
  assert.equal(opt.series.length, 1);
  const s = opt.series[0];
  assert.equal(s.type, 'gauge');
  assert.equal(s.max, 2620);
  assert.equal(s.progress.show, true);
  assert.equal(s.progress.roundCap, true);
  assert.equal(s.axisLine.roundCap, true);
  assert.equal(s.data[0].value ?? s.data[0], 1840);
  assert.equal(rgbHex(s.progress.itemStyle.color), tk.calories.toLowerCase());
  const track = s.axisLine.lineStyle.color[0][1];
  assert.equal(rgbHex(track), tk.calories.toLowerCase(), 'track is the accent color');
  assert.ok(alphaOf(track) <= 0.2 && alphaOf(track) > 0, 'track alpha <= 20%');
  assert.equal(s.axisTick.show, false);
  assert.equal(s.splitLine.show, false);
  assert.equal(s.axisLabel.show, false);
  assert.equal(s.pointer.show, false);
  assertCommon(opt, 'rings');
});

test('ringOption: accent picks the token color; dark tokens work', () => {
  const opt = ringOption({ value: 70, goal: 180 }, TOKENS.dark, { accent: 'protein' });
  assert.equal(rgbHex(opt.series[0].progress.itemStyle.color), TOKENS.dark.protein.toLowerCase());
});

test('ringOption: value above goal adds a second lap in the over color', () => {
  const opt = ringOption({ value: 2740, goal: 2620 }, tk, { accent: 'calories' });
  assert.equal(opt.series.length, 2);
  const lap = opt.series[1];
  assert.equal(lap.type, 'gauge');
  assert.equal(lap.max, 2620);
  assert.equal(lap.data[0].value ?? lap.data[0], 120);
  assert.equal(lap.progress.show, true);
  assert.equal(rgbHex(lap.progress.itemStyle.color), tk.over.toLowerCase());
  // first lap is full
  assert.equal(opt.series[0].data[0].value ?? opt.series[0].data[0], 2620);
});

test('ringOption: not over -> single series; reducedMotion disables animation', () => {
  assert.equal(ringOption({ value: 2620, goal: 2620 }, tk, { accent: 'calories' }).series.length, 1);
  assert.equal(ringOption({ value: 1, goal: 2 }, tk, { accent: 'calories', reducedMotion: true }).animation, false);
});

test('ringLabel: center label computed separately', () => {
  assert.deepEqual(ringLabel({ value: 1840, goal: 2620 }), { big: '1,840', small: 'of 2,620 kcal', caption: '780 left' });
  assert.deepEqual(ringLabel({ value: 2740, goal: 2620 }), { big: '2,740', small: 'of 2,620 kcal', caption: '120 over' });
  assert.deepEqual(ringLabel({ value: 70, goal: 180 }, { unit: 'g' }), { big: '70', small: 'of 180 g', caption: '110 left' });
});

// ---------- weight ----------
const wopt = weightOption(data, tk, { range: 30 });

test('weightOption: scale scatter is faint and small', () => {
  const s = seriesOf(wopt, 'scatter', 'scale');
  assert.ok(s, 'scatter series named scale');
  assert.ok(s.symbolSize <= 6);
  const op = s.itemStyle?.opacity ?? s.opacity;
  assert.ok(op <= 0.45 && op > 0, 'opacity <= 0.45');
  assert.equal(s.data.length, data.weight.scale.length);
  assert.deepEqual(pt(s.data[0]).map(String), [data.weight.scale[0].day, String(data.weight.scale[0].kg)]);
});

test('weightOption: smooth trend line with vertical accent gradient area', () => {
  const s = seriesOf(wopt, 'line', 'trend');
  assert.ok(s, 'line series named trend');
  assert.ok(s.smooth);
  assert.equal(s.lineStyle.width, 3);
  assert.equal(rgbHex(s.lineStyle.color ?? s.itemStyle?.color), tk.weight.toLowerCase());
  assert.equal(s.data.length, data.weight.trend.length);
  const g = s.areaStyle.color;
  assert.equal(g.type, 'linear');
  assert.deepEqual([g.x, g.y, g.x2, g.y2], [0, 0, 0, 1]);
  const stops = g.colorStops;
  assert.equal(stops[0].offset, 0);
  assert.equal(stops.at(-1).offset, 1);
  assert.equal(rgbHex(stops[0].color), tk.weight.toLowerCase());
  assert.ok(Math.abs(alphaOf(stops[0].color) - 0.25) < 0.01, 'top alpha 0.25');
  assert.ok(alphaOf(stops.at(-1).color) < 0.01, 'bottom alpha 0');
});

test('weightOption: goal markLine only when goal is within 3 kg of the y-range', () => {
  const hasMark = (o) => arr(o.series).some((s) => s.markLine);
  assert.equal(hasMark(wopt), false, 'demo: goal 100 kg is ~15 kg away -> absent');

  const near = structuredClone(data);
  near.weight.scale = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'].map((day, i) => ({ day, kg: 103.2 - i * 0.2 }));
  near.weight.trend = near.weight.scale.map((p) => ({ day: p.day, kg: p.kg - 0.1 }));
  const o = weightOption(near, tk, { range: 7 });
  const s = arr(o.series).find((x) => x.markLine);
  assert.ok(s, 'goal line present when near');
  const ml = s.markLine;
  assert.equal(ml.lineStyle.type, 'dashed');
  assert.ok(JSON.stringify(ml).includes('Goal 100 kg'), 'labelled Goal 100 kg');
  assert.ok(JSON.stringify(ml.data).includes('100'), 'at y = 100');

  const far = structuredClone(near);
  far.goals.target_weight_kg = 90;
  assert.equal(arr(weightOption(far, tk, { range: 7 }).series).some((x) => x.markLine), false);
});

test('weightOption: dashed plan-pace line, 30 days at -plan_kg_per_week/7', () => {
  const s = seriesOf(wopt, 'line', 'plan pace');
  assert.ok(s, 'line series named plan pace');
  assert.equal(s.lineStyle.type, 'dashed');
  const last = data.weight.trend.at(-1);
  const first = pt(s.data[0]);
  const end = pt(s.data.at(-1));
  assert.equal(first[0], last.day);
  assert.ok(Math.abs(Number(first[1]) - last.kg) < 0.01);
  assert.equal(end[0], addDays(last.day, 30));
  const expected = last.kg - (30 * data.goals.plan_kg_per_week) / 7;
  assert.ok(Math.abs(Number(end[1]) - expected) < 0.01, `end ${end[1]} ~ ${expected}`);
});

test('weightOption: y-axis is data min/max +-1 kg rounded to whole kg', () => {
  const vals = [...data.weight.scale, ...data.weight.trend].map((p) => p.kg);
  const y = arr(wopt.yAxis)[0];
  assert.equal(y.min, Math.floor(Math.min(...vals) - 1));
  assert.equal(y.max, Math.ceil(Math.max(...vals) + 1));
});

test('weightOption: tooltip, axes, motion', () => {
  const t = wopt.tooltip;
  assert.equal(t.trigger, 'axis');
  assert.ok(String(t.triggerOn).includes('click'));
  assert.equal(t.confine, true);
  assertCommon(wopt, 'weight');
  assertAxes(wopt, tk, 'weight');
  assert.equal(weightOption(data, tk, { range: 30, reducedMotion: true }).animation, false);
  assertAxes(weightOption(data, TOKENS.dark, { range: 30 }), TOKENS.dark, 'weight dark');
});

test('weightOption: fewer than 2 weigh-ins -> empty message', () => {
  const msg = { empty: 'Not enough weigh-ins in this range' };
  const one = structuredClone(data);
  one.weight.scale = one.weight.scale.slice(0, 1);
  assert.deepEqual(weightOption(one, tk, { range: 7 }), msg);
  const none = structuredClone(data);
  none.weight.scale = [];
  assert.deepEqual(weightOption(none, tk, { range: 7 }), msg);
});

test('weightHero: live scale kg, with trend and range change in the caption', () => {
  const h = weightHero(data);
  assert.equal(h.value, fmtKg(data.weight.current_kg));
  assert.equal(h.unit, 'kg');
  assert.ok(h.caption.includes(`Trend ${fmtKg(data.weight.current_trend_kg)}`), h.caption);
  assert.ok(h.caption.includes(`${MINUS}0.6 kg`), h.caption);
  assert.ok(h.caption.includes('30 days'), h.caption);
});

// ---------- ftp ----------
const fopt = ftpOption(data, tk, { range: 365 });

test('ftpOption: FTP step line with gradient area, W/kg on right axis, test symbols', () => {
  const f = seriesOf(fopt, 'line', 'FTP');
  assert.ok(f, 'line series named FTP');
  assert.equal(f.step, 'end');
  const g = f.areaStyle.color;
  assert.equal(g.type, 'linear');
  assert.deepEqual([g.x, g.y, g.x2, g.y2], [0, 0, 0, 1]);
  assert.equal(rgbHex(g.colorStops[0].color), tk.ftp.toLowerCase());
  assert.ok(alphaOf(g.colorStops.at(-1).color) < 0.01);
  assert.equal(rgbHex(f.lineStyle.color ?? f.itemStyle?.color), tk.ftp.toLowerCase());

  const w = seriesOf(fopt, 'line', 'W/kg');
  assert.ok(w, 'line series named W/kg');
  assert.equal(w.yAxisIndex, 1);
  const ys = arr(fopt.yAxis);
  assert.equal(ys.length, 2);
  assert.equal(ys[1].position, 'right');

  const tests = seriesOf(fopt, 'scatter', 'tests');
  assert.ok(tests, 'scatter series named tests');
  assert.equal(tests.data.length, data.ftp.tests.length);
  assert.ok(tests.symbolSize >= 8, 'emphasized symbols');
});

test('ftpOption: tooltip, axes, motion', () => {
  assert.equal(fopt.tooltip.trigger, 'axis');
  assert.ok(String(fopt.tooltip.triggerOn).includes('click'));
  assert.equal(fopt.tooltip.confine, true);
  assertCommon(fopt, 'ftp');
  assertAxes(fopt, tk, 'ftp');
  assert.equal(ftpOption(data, tk, { range: 365, reducedMotion: true }).animation, false);
});

test('ftpHero: W/kg with FTP watts', () => {
  const h = ftpHero(data);
  assert.equal(h.value, '2.29');
  assert.equal(h.unit, 'W/kg');
  assert.ok(h.caption.includes('265 W'), h.caption);
});
