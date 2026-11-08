import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRoadmap, smoothTrend, trendAt } from '../../src/roadmap.mjs';
import { addDays } from '../../src/aggregate.mjs';

const TODAY = '2026-10-28'; // a Wednesday; the check-in snapshot is Sunday 2026-10-25
const road = (weights, over = {}) =>
  buildRoadmap({ series: smoothTrend(weights), today: TODAY, target: 100, cap: 0.75, startKg: 115.6, ...over });
const daily = (from, n, kgAt) => Array.from({ length: n }, (_, i) => ({ day: addDays(from, i), kg: kgAt(i) }));

describe('smoothTrend / trendAt', () => {
  test('first reading seeds the trend; later readings move it by 1-exp(-days/7)', () => {
    const s = smoothTrend([{ day: '2026-10-20', kg: 100 }, { day: '2026-10-22', kg: 102 }]);
    assert.equal(s[0].t, 100);
    assert.ok(Math.abs(s[1].t - (100 + (1 - Math.exp(-2 / 7)) * 2)) < 1e-9);
  });

  test('trendAt carries the last point forward, within maxGap', () => {
    const s = smoothTrend([{ day: '2026-10-20', kg: 100 }]);
    assert.equal(trendAt(s, '2026-10-19'), null);
    assert.equal(trendAt(s, '2026-10-25').day, '2026-10-20');
    assert.equal(trendAt(s, '2026-10-25', 3), null);
  });
});

describe('buildRoadmap', () => {
  test('null without readings, a target or a cap', () => {
    assert.equal(road([]), null);
    assert.equal(road([{ day: '2026-10-20', kg: 100 }], { target: null }), null);
    assert.equal(road([{ day: '2026-10-20', kg: 100 }], { cap: 0 }), null);
  });

  test('few weigh-ins -> planning paces; windows ordered brisk < likely < gentle; snapshot is the last Sunday', () => {
    const r = road(daily('2026-10-22', 5, () => 115));
    assert.equal(r.snapshot_day, '2026-10-25');
    assert.equal(r.next_update, '2026-11-01');
    assert.equal(r.pace.mode, 'planning');
    assert.deepEqual(r.windows.map((w) => w.kg_per_week), [0.75, 0.5, 0.35]);
    const [b, l, g] = r.windows.map((w) => w.date);
    assert.ok(b < l && l < g);
    assert.equal(b, addDays('2026-10-25', Math.round((115 / 0.75 - 100 / 0.75) * 7)));
  });

  test('snapshot ignores weigh-ins after the Sunday check-in', () => {
    const ws = [...daily('2026-10-20', 6, () => 115), { day: '2026-10-27', kg: 110 }];
    const r = road(ws);
    assert.ok(Math.abs(r.snapshot_trend_kg - 115) < 1e-6);
    assert.ok(r.trend_kg < 115); // the live trend has already moved
  });

  test('steady loss over four weeks -> measured pace, brisk capped at 0.75', () => {
    const r = road(daily('2026-09-20', 38, (i) => 118 - 0.08 * i));
    assert.equal(r.pace.mode, 'measured');
    assert.ok(r.pace.actual_kg_per_week > 0.4 && r.pace.actual_kg_per_week < 0.6, String(r.pace.actual_kg_per_week));
    assert.equal(r.windows.find((w) => w.key === 'likely').kg_per_week, r.pace.actual_kg_per_week);
    assert.ok(r.windows.find((w) => w.key === 'brisk').kg_per_week <= 0.75);
  });

  test('faster than the cap -> mode fast, windows never faster than the cap', () => {
    const r = road(daily('2026-09-20', 38, (i) => 130 - 0.5 * i));
    assert.equal(r.pace.mode, 'fast');
    assert.ok(r.windows.every((w) => w.kg_per_week <= 0.75));
  });

  test('at or below goal -> no windows, every finish line reached', () => {
    const r = road(daily('2026-10-22', 6, () => 99));
    assert.deepEqual(r.windows, []);
    assert.ok(r.finish_lines.every((f) => f.reached && f.date === null));
  });

  test('finish lines run 112.5 down to 100 in 2.5 kg steps, with dates only for those ahead', () => {
    const r = road(daily('2026-10-22', 6, () => 111));
    assert.deepEqual(r.finish_lines.map((f) => f.kg), [112.5, 110, 107.5, 105, 102.5, 100]);
    assert.deepEqual(r.finish_lines.map((f) => f.reached), [true, false, false, false, false, false]);
    assert.ok(r.finish_lines.slice(1).every((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.date)));
  });

  test('weekly check-ins: four Sundays, newest first, with change vs the week before', () => {
    const r = road(daily('2026-09-20', 38, (i) => 118 - 0.3 * i));
    assert.deepEqual(r.weeks.map((w) => w.week_end), ['2026-10-25', '2026-10-18', '2026-10-11', '2026-10-04']);
    assert.equal(r.weeks[0].weigh_ins, 7);
    assert.ok(r.weeks[0].change_kg < 0);
    assert.equal(r.weeks[3].change_kg, null); // the week before the oldest one shown is not listed
  });

  test('a week with no weigh-ins has no trend and no change', () => {
    const r = road([{ day: '2026-10-05', kg: 116 }, { day: '2026-10-26', kg: 115 }]);
    assert.equal(r.weeks[0].weigh_ins, 0);
    assert.equal(r.weeks[0].trend_kg, null);
    assert.equal(r.weeks[0].change_kg, null);
  });

  test('series is the last 120 days, raw and trend', () => {
    const r = road([{ day: '2026-05-01', kg: 120 }, { day: '2026-10-26', kg: 115 }]);
    assert.deepEqual(r.series.map((p) => p.day), ['2026-10-26']);
    assert.equal(r.series[0].kg, 115);
    assert.ok(r.series[0].trend_kg < 115.1);
  });
});
