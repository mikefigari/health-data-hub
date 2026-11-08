import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../../src/aggregate.mjs';
import { balanceOption, balanceHero } from '../../public/js/charts/balance.mjs';
import { TOKENS } from '../../public/js/core.mjs';

// Wed 2026-10-28; Mon 26 and Tue 27 logged, Tue has a 1000 kJ ride.
const inputs = {
  today: '2026-10-28',
  rangeDays: 7,
  planKgPerWeek: 0.6545,
  maintenanceKcal: 2620,
  weights: [],
  goals: [{ effective_from: '2026-10-26', target_weight_kg: 100, base_calories: 1900, cycling_kj_factor: 1, protein_g: 180 }],
  rideKj: [{ day: '2026-10-27', kj: 1000 }],
  nutrition: [
    { day: '2026-10-26', calories: 1900, protein_g: 150, carbs_g: 150, fat_g: 60, goal_calories: 1900, logged_complete: true },
    { day: '2026-10-27', calories: 2900, protein_g: 150, carbs_g: 300, fat_g: 60, goal_calories: 2900, logged_complete: true },
  ],
};

test('weekly deficit = baseline + ride kJ - eaten, on logged days', () => {
  const d = buildDashboard(inputs);
  assert.equal(d.energy.maintenance_kcal, 2620);
  assert.equal(d.energy.week_deficit_kcal, 720 + 720);
  assert.equal(d.energy.week_target_kcal, 5040);
  assert.equal(d.energy.daily_target_kcal, 720);
  assert.equal(d.energy.week_ride_kj, 1000);
  assert.equal(d.nutrition.days.at(-2).deficit_kcal, 720);
});

test('balance chart and hero', () => {
  const d = buildDashboard(inputs);
  const h = balanceHero(d);
  assert.equal(h.value, '1,440');
  assert.match(h.unit, /deficit/);
  const o = balanceOption(d, TOKENS.light, { range: 7 });
  assert.equal(o.series[0].data.filter(Boolean).length, 2);
  assert.ok(balanceOption({ ...d, nutrition: { days: [], weeks: [] } }, TOKENS.light).empty);
});
