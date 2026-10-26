// T2-spec (integration): DB inputs for the weekly nutrition review, and the LA
// ride day in EXPORT_SQL.
//
// Contract pinned here (src/utils/db.mjs):
//   getNutritionWeekInputs(startDay, endDay)  // both 'YYYY-MM-DD', inclusive
//     -> {
//          nutrition: [{ day:'YYYY-MM-DD', calories, goal_calories, logged_complete }],
//                     // flat nutrition_daily rows for startDay..endDay, ordered by day
//                     // ascending. A day without food is absent or has calories null.
//                     // calories/goal_calories may be numbers or numeric strings.
//          weighIns:  [{ day:'YYYY-MM-DD', weight_kg }],
//                     // body_weight_daily, ordered by day ascending, for the window
//                     // (endDay - 28 days) .. endDay. Days outside are excluded.
//          goals:     { target_weight_kg, base_calories, ... },
//                     // the current nutrition_goals row (numbers or numeric strings)
//        }
//   EXPORT_SQL / exportDays bucket workouts and the PMC lookback by the
//   America/Los_Angeles date of the naive-UTC workout_summary.start_time.
//
// Needs TEST_DATABASE_URL. The suite FAILS (not skips) when it is unset; test (f)
// proves that by re-running this file in a child process without it.
// All fixtures are synthetic and inserted as the test superuser.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { freshInstall, resetDb, closePools } from '../../../health-mcp/test/helpers/testdb.mjs';

const IS_CHILD = process.env.HDH_T2_CHILD === '1';

// Point db.mjs at the test cluster, then validate the values db.mjs will use.
function configureFromTestUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  assert.ok(raw, 'TEST_DATABASE_URL must be set for the integration suite');
  const u = new URL(raw);
  assert.equal(u.search, '', 'TEST_DATABASE_URL must not carry query parameters');
  process.env.DB_HOST = u.hostname;
  process.env.DB_PORT = u.port || '5432';
  process.env.DB_NAME = decodeURIComponent(u.pathname.replace(/^\//, ''));
  process.env.DB_USER = decodeURIComponent(u.username || 'postgres');
  process.env.DB_PASSWORD = decodeURIComponent(u.password || '');
  assert.ok(['localhost', '127.0.0.1'].includes(process.env.DB_HOST), 'DB_HOST must be localhost or 127.0.0.1');
  assert.ok(process.env.DB_NAME.endsWith('_test'), 'DB_NAME must end in _test');
  return raw;
}

let admin;
let db;

describe('notion-reporter weekly DB inputs', () => {
  before(async () => {
    const raw = configureFromTestUrl();
    await resetDb();
    await freshInstall();
    admin = new pg.Pool({ connectionString: raw, max: 2 });

    // Food: three LA days. 2026-10-25 = 800 + 1200, 10-26 = 2500, 10-27 = 1800.
    const food = [
      ['2026-10-25 08:00:00-07', 'breakfast', 800],
      ['2026-10-25 19:00:00-07', 'dinner', 1200],
      ['2026-10-26 12:00:00-07', 'lunch', 2500],
      ['2026-10-27 12:00:00-07', 'lunch', 1800],
    ];
    for (const [at, meal, kcal] of food) {
      await admin.query(
        `INSERT INTO food_log (eaten_at, meal, description, calories, protein_g, carbs_g, fat_g,
                               confidence, match_source, created_via)
         VALUES ($1, $2, 'synthetic', $3, 10, 10, 10, 'high', 'estimate', 'manual')`,
        [at, meal, kcal],
      );
    }
    await admin.query(`INSERT INTO nutrition_day_status (day, logged_complete) VALUES ('2026-10-27', false)`);

    // Weigh-ins, inserted out of order. Window for endDay 2026-10-28 is 2026-09-30..2026-10-28.
    const weights = [
      ['2026-10-20', 103.4],
      ['2026-09-29', 106.0], // before the window
      ['2026-10-28', 102.8],
      ['2026-10-01', 105.1],
      ['2026-10-29', 102.5], // after endDay
    ];
    for (const [day, kg] of weights) {
      await admin.query(
        `INSERT INTO body_measurements (measured_at, local_day, source, weight_kg)
         VALUES ($1::date + time '07:00', $1::date, 'apple_health', $2)`,
        [day, kg],
      );
    }

    // Ride: 2026-10-27 05:30 naive UTC = 2026-10-26 22:30 PDT, so LA day 2026-10-26.
    await admin.query(
      `INSERT INTO workouts_raw (id, source, external_id, start_time, sport_type, kj, device_watts)
       VALUES (9001, 'strava', 't2-ride', '2026-10-27 05:30:00', 'Ride', 500, true)`,
    );
    await admin.query(
      `INSERT INTO workout_summary (workout_id, sport_type, title, start_time, moving_s, kj, device_watts, tss_power)
       VALUES (9001, 'Ride', 'Synthetic evening ride', '2026-10-27 05:30:00', 3600, 500, true, 80)`,
    );

    db = await import('../../src/utils/db.mjs');
  });

  after(async () => {
    try { await db?.closePool?.(); } catch {}
    try { await admin?.end(); } catch {}
    await closePools();
  });

  const dayStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

  test('(a) per-day calories, goal_calories and logged_complete', async () => {
    assert.equal(typeof db.getNutritionWeekInputs, 'function');
    const { nutrition } = await db.getNutritionWeekInputs('2026-10-25', '2026-10-28');
    const by = Object.fromEntries(nutrition.map((r) => [r.day, r]));
    assert.equal(Number(by['2026-10-25'].calories), 2000);
    assert.equal(Number(by['2026-10-26'].calories), 2500);
    assert.equal(Number(by['2026-10-27'].calories), 1800);
    // goal = base 2620 + powered ride kJ on the LA ride day (10-26)
    assert.equal(Number(by['2026-10-25'].goal_calories), 2620);
    assert.equal(Number(by['2026-10-26'].goal_calories), 3120);
    assert.equal(Number(by['2026-10-27'].goal_calories), 2620);
    assert.equal(by['2026-10-27'].logged_complete, false);
    assert.notEqual(by['2026-10-25'].logged_complete, false);
    assert.notEqual(by['2026-10-26'].logged_complete, false);
    const days = nutrition.map((r) => r.day);
    assert.deepEqual(days, [...days].sort());
  });

  test('(b) a day without food rows is absent or has null calories', async () => {
    const { nutrition } = await db.getNutritionWeekInputs('2026-10-25', '2026-10-28');
    const row = nutrition.find((r) => r.day === '2026-10-28');
    assert.ok(row === undefined || row.calories === null || row.calories === undefined);
  });

  test('(c) weigh-ins in the 28-day window, ordered, outside excluded', async () => {
    const { weighIns } = await db.getNutritionWeekInputs('2026-10-25', '2026-10-28');
    assert.deepEqual(weighIns.map((w) => w.day), ['2026-10-01', '2026-10-20', '2026-10-28']);
    assert.deepEqual(weighIns.map((w) => Number(w.weight_kg)), [105.1, 103.4, 102.8]);
  });

  test('(d) goals row has target weight 100.0 and base calories 2620', async () => {
    const { goals } = await db.getNutritionWeekInputs('2026-10-25', '2026-10-28');
    assert.equal(Number(goals.target_weight_kg), 100.0);
    assert.equal(Number(goals.base_calories), 2620);
  });

  test('(e) EXPORT_SQL buckets the ride and PMC by LA date', async () => {
    const { days } = await db.exportDays('2026-10-24', '2026-10-28');
    const by = Object.fromEntries(days.map((d) => [dayStr(d.day), d]));
    assert.equal(by['2026-10-26'].workouts.length, 1);
    assert.equal(by['2026-10-26'].workouts[0].title, 'Synthetic evening ride');
    assert.equal(by['2026-10-27'].workouts.length, 0);
    // PMC lookback joins on the same LA day: TSS 80 lands on 10-26, not 10-27.
    assert.equal(Number(by['2026-10-25'].performance_management.ctl), 0);
    assert.ok(Number(by['2026-10-26'].performance_management.ctl) > 0, 'ctl rises on the LA ride day');
    assert.ok(Number(by['2026-10-26'].performance_management.atl) > 10, 'atl rises on the LA ride day');
  });
});

if (!IS_CHILD) {
  test('(f) the suite fails, not skips, when TEST_DATABASE_URL is unset', () => {
    const env = { ...process.env, HDH_T2_CHILD: '1' };
    delete env.TEST_DATABASE_URL;
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'child run without TEST_DATABASE_URL must exit non-zero');
  });
}
