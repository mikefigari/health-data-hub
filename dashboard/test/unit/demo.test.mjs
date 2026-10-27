// T3 spec: deterministic demo inputs.
// Module interface assumed: src/demo.mjs exports demoInputs(today) -> inputs for buildDashboard.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { demoInputs } from '../../src/demo.mjs';
import { buildDashboard } from '../../src/aggregate.mjs';

const TODAY = '2026-10-26';

describe('demoInputs', () => {
  test('deterministic for the same date (seeded PRNG)', () => {
    assert.deepEqual(demoInputs(TODAY), demoInputs(TODAY));
  });

  test('has the input shape', () => {
    const i = demoInputs(TODAY);
    assert.equal(i.today, TODAY);
    for (const k of ['weights', 'nutrition', 'goals', 'rideKj', 'ftp']) assert.ok(Array.isArray(i[k]), k);
  });

  const year = buildDashboard({ ...demoInputs(TODAY), rangeDays: 365 });

  test('at least 250 weigh-ins over 365 days trending ~121 -> ~116 kg', () => {
    assert.ok(year.weight.scale.length >= 250, `got ${year.weight.scale.length}`);
    assert.ok(year.weight.trend[0].kg > 119 && year.weight.trend[0].kg < 123, `start ${year.weight.trend[0].kg}`);
    assert.ok(
      year.weight.current_trend_kg > 114.5 && year.weight.current_trend_kg < 117.5,
      `end ${year.weight.current_trend_kg}`,
    );
  });

  test('last 30 days exercise every nutrition state', () => {
    const r = buildDashboard({ ...demoInputs(TODAY), rangeDays: 30 });
    const days = r.nutrition.days;
    const has = (s) => days.some((d) => d.status === s);
    assert.ok(has('missing'), 'missing');
    assert.ok(has('incomplete'), 'incomplete');
    const logged = days.filter((d) => d.status === 'logged' && d.goal_calories != null);
    assert.ok(logged.some((d) => d.calories > d.goal_calories), 'over');
    assert.ok(logged.some((d) => d.calories <= d.goal_calories), 'under');
    assert.equal(days.at(-1).day, TODAY);
    assert.equal(days.at(-1).status, 'partial');
  });

  test('5 FTP tests rising 230 -> 265 W', () => {
    const t = year.ftp.tests;
    assert.equal(t.length, 5);
    assert.equal(t[0].ftp_w, 230);
    assert.equal(t.at(-1).ftp_w, 265);
    for (let i = 1; i < t.length; i++) assert.ok(t[i].ftp_w >= t[i - 1].ftp_w);
  });
});
