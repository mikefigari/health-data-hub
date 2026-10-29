// T1-spec. Row shape (as buildWeeklyContext): { day:'YYYY-MM-DD', nutrition:{ calories, goal_calories, logged_complete, ride_kcal } }
// Weigh-ins: [{ day, weight_kg }]. Result field names below are the contract.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  laToday, priorWeekBounds, currentWeekMonWed,
  weeklyDeficit, weightTrend, calibratedMaintenance, thursdayCheck, maintenanceKcal,
} from '../../src/utils/nutritionWeek.mjs';

const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const row = (day, calories, goal = 2600, complete = true) =>
  ({ day, nutrition: { calories, goal_calories: goal, logged_complete: complete } });
// n consecutive days from `start`, each with deficit `def` (goal 2600).
const run = (start, n, def) => Array.from({ length: n }, (_, i) => row(addDays(start, i), 2600 - def));
const at2000 = (days) => days.map(r => ({ ...r, nutrition: { ...r.nutrition, calories: 2000 } }));
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

// Helpers use goal 2600, so maintenance is pinned to 2600 here so the deficits are unchanged.
// The 2620 default is tested at (k).
let saved, savedMaint;
beforeEach(() => {
  saved = process.env.WEEKLY_LOSS_TARGET_KG; delete process.env.WEEKLY_LOSS_TARGET_KG;
  savedMaint = process.env.MAINTENANCE_KCAL; process.env.MAINTENANCE_KCAL = '2600';
});
afterEach(() => {
  if (saved === undefined) delete process.env.WEEKLY_LOSS_TARGET_KG; else process.env.WEEKLY_LOSS_TARGET_KG = saved;
  if (savedMaint === undefined) delete process.env.MAINTENANCE_KCAL; else process.env.MAINTENANCE_KCAL = savedMaint;
});

test('(a) laToday returns the Los Angeles date', () => {
  assert.equal(laToday(new Date('2026-11-02T07:30:00Z')), '2026-11-01');
  assert.equal(laToday(new Date('2026-11-02T09:30:00Z')), '2026-11-02');
});

test('(b) week bounds', () => {
  assert.deepEqual(priorWeekBounds('2026-11-02'), { start: '2026-10-26', end: '2026-11-01' });
  assert.deepEqual(currentWeekMonWed('2026-11-05'), { start: '2026-11-02', end: '2026-11-04' });
});

test('(c) 7 usable days averaging 900', () => {
  const r = weeklyDeficit(run('2026-10-26', 7, 900));
  assert.equal(r.on_track, true);
  assert.equal(r.status, 'deficit');
  assert.equal(r.avg_deficit, 900);
  assert.equal(r.projected_week_total, 6300);
  assert.equal(r.target_total, 5775);
  assert.equal(r.n_usable, 7);
});

test('(d) off track and surplus', () => {
  const low = weeklyDeficit(run('2026-10-26', 7, 500));
  assert.equal(low.on_track, false);
  assert.equal(low.status, 'deficit');
  const sur = weeklyDeficit(run('2026-10-26', 7, -200));
  assert.equal(sur.status, 'surplus');
  assert.equal(sur.on_track, false);
});

test('(d2) on_track boundary is >= 825 and judged on the average, not per day', () => {
  assert.equal(weeklyDeficit(run('2026-10-26', 7, 825)).on_track, true);
  const mixed = [...run('2026-10-26', 3, 1600), ...run('2026-10-29', 4, 300)]; // avg ~857.1 despite 4 low days
  assert.equal(weeklyDeficit(mixed).on_track, true);
});

test('(e) usable-day filter', () => {
  const days = [
    row('2026-10-26', 0),                 // no food
    row('2026-10-27', 1700, 2600, false), // marked incomplete
    row('2026-10-28', 1700, null, null),  // no goal row: maintenance is still fixed -> deficit 900
    row('2026-10-29', 1600, 2600, null),  // null complete counts -> deficit 1000
    row('2026-10-30', 1800, 2600, true),  // deficit 800
    row('2026-10-31', 1800, 2600, false), // incomplete
  ];
  const r = weeklyDeficit(days);
  assert.equal(r.n_usable, 3);
  assert.equal(r.avg_deficit, 900);
  assert.equal(r.n_logged, 5);          // calories > 0 days
  assert.equal(r.n_marked_complete, 1); // only logged_complete === true among logged days
});

test('(f) zero usable days', () => {
  const r = weeklyDeficit([row('2026-10-26', 0), row('2026-10-27', 1500, 2600, false)]);
  assert.equal(r.status, 'no_data');
  assert.equal(r.avg_deficit, null);
  assert.equal(r.n_usable, 0);
});

const W = [
  { day: '2026-10-12', weight_kg: 110.0 }, { day: '2026-10-19', weight_kg: 109.5 },
  { day: '2026-10-26', weight_kg: 109.0 }, { day: '2026-11-02', weight_kg: 108.5 },
];

test('(g) weightTrend', () => {
  const t = weightTrend(W, { asOf: '2026-11-04', targetKg: 100.0 });
  near(t.trend_kg_per_week, -0.5, 0.01);
  assert.equal(t.latest_kg, 108.5);
  assert.equal(t.latest_day, '2026-11-02');
  assert.equal(t.days_since_weigh_in, 2);
  near(t.kg_to_target, 8.5, 0.001);
  // 8.5 kg at 0.75/wk = 79 d; at 0.5/wk = 119 d (from asOf or latest weigh-in)
  near(dayDiff(t.target_date_at_rate, '2026-11-04'), 79, 3);
  near(dayDiff(t.target_date_at_trend, '2026-11-04'), 119, 3);
});

test('(g2) single weigh-in -> no trend', () => {
  const t = weightTrend([W[0]], { asOf: '2026-11-04', targetKg: 100.0 });
  assert.equal(t.trend_kg_per_week, null);
  assert.equal(t.reason, 'insufficient_weigh_ins');
});

test('(g3) weigh-ins under 7 days apart -> no trend; gaining -> no trend date', () => {
  const t = weightTrend([W[0], { day: '2026-10-15', weight_kg: 109.8 }], { asOf: '2026-11-04', targetKg: 100.0 });
  assert.equal(t.trend_kg_per_week, null);
  assert.equal(t.reason, 'insufficient_weigh_ins');
  const gain = weightTrend(W.map((w, i) => ({ ...w, weight_kg: 108 + i * 0.5 })), { asOf: '2026-11-04', targetKg: 100.0 });
  assert.ok(gain.trend_kg_per_week > 0);
  assert.ok(gain.target_date_at_trend == null);
});

test('(h) calibratedMaintenance below thresholds', () => {
  const asOf = '2026-11-02';
  let c = calibratedMaintenance(at2000(run('2026-10-14', 20, 600)), W, { asOf }); // 20 usable days
  assert.equal(c.method, 'fixed_maintenance');
  assert.equal(c.maintenance_est, null);
  c = calibratedMaintenance(at2000(run('2026-10-13', 21, 600)), W.slice(0, 3), { asOf }); // 3 weigh-ins
  assert.equal(c.method, 'fixed_maintenance');
  assert.equal(c.maintenance_est, null);
});

test('(h2) calibratedMaintenance at thresholds', () => {
  const c = calibratedMaintenance(at2000(run('2026-10-13', 21, 600)), W, { asOf: '2026-11-02' }); // 10-13..11-02
  assert.notEqual(c.method, 'fixed_maintenance');
  near(c.maintenance_est, 2000 + (0.5 / 7) * 7700, 1); // 2550
});

test('(i) thursdayCheck on track', () => {
  const r = thursdayCheck(run('2026-11-02', 3, 900));
  assert.equal(r.on_track, true);
  assert.equal(r.post, false);
});

test('(i2) thursdayCheck off track', () => {
  const r = thursdayCheck(run('2026-11-02', 3, 400));
  assert.equal(r.on_track, false);
  assert.equal(r.post, true);
  assert.equal(r.shortfall, 1275);
  assert.equal(r.needed_per_day_thu_sun, 1144);
});

test('(i3) thursdayCheck no data', () => {
  const r = thursdayCheck([row('2026-11-02', 0), row('2026-11-03', 1500, 2600, false)]);
  assert.equal(r.status, 'no_data');
  assert.equal(r.post, true);
});

test('(j) rate from WEEKLY_LOSS_TARGET_KG', () => {
  process.env.WEEKLY_LOSS_TARGET_KG = '0.5';
  assert.equal(weeklyDeficit(run('2026-10-26', 7, 900)).target_total, 3850);
});

test('(k) maintenance defaults to 2620 and ignores the daily goal', () => {
  delete process.env.MAINTENANCE_KCAL;
  assert.equal(maintenanceKcal(), 2620);
  const r = weeklyDeficit([{ day: '2026-10-26', nutrition: { calories: 1700, goal_calories: 1900, logged_complete: true } }]);
  assert.equal(r.avg_deficit, 920); // 2620 - 1700, not 1900 - 1700
});

test('(l) ride kcal raises that day\'s maintenance', () => {
  const days = [
    { day: '2026-10-26', nutrition: { calories: 1700, logged_complete: true, ride_kcal: 0 } },
    { day: '2026-10-27', nutrition: { calories: 1700, logged_complete: true, ride_kcal: 500 } },
  ];
  const r = weeklyDeficit(days);
  assert.equal(r.n_usable, 2);
  assert.equal(r.avg_deficit, 1150); // maintenance pinned to 2600 by beforeEach: (900 + 1400) / 2
});
