// T1 spec: maintenance_calories on nutrition_goals, the 2026-10-28 goal row and
// the trailing nutrition_daily.maintenance_calories column
// (migration health_data_hub/db/migrations/2026-11_04_maintenance_calories.sql,
// same end state in health_data_hub/db/schema.sql; PLAN.md D1-D4, A2-A5).
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Model: a food_log day's goal        = base_calories        + round(factor * powered Ride kJ)
//        a food_log day's maintenance = maintenance_calories + round(factor * powered Ride kJ)
//        legacy-table days return maintenance_calories NULL.
//
// Behaviour tests (a)-(e), (g) run against both upgradeInstall() and
// freshInstall(); (f) runs the down script on the pre-04 upgrade path.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  resetDb,
  freshInstall,
  upgradeInstall,
  migrationFiles,
  catalogSnapshot,
  writerPool,
  dashboardPool,
  closePools,
} from '../helpers/testdb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const DB_DIR = path.join(REPO, 'health_data_hub/db');
const BASELINE_SQL = path.join(DB_DIR, 'baseline/schema_2026-10.sql');
const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');
const MIGRATION_NAME = '2026-11_04_maintenance_calories';
const UP = path.join(MIGRATIONS_DIR, `${MIGRATION_NAME}.sql`);
const DOWN = path.join(MIGRATIONS_DIR, `${MIGRATION_NAME}.down.sql`);
const FIXTURE = path.join(HERE, '../fixtures/nutrition_daily_rows.sql');
const FIXTURE_ROWS = 10;

// nutrition_daily's columns before migration 04, in order, with declared types.
const PRE_04_COLUMNS = [
  ['day', 'date'],
  ['calories', 'integer'],
  ['protein_g', 'double precision'],
  ['carbs_g', 'double precision'],
  ['fat_g', 'double precision'],
  ['fiber_g', 'double precision'],
  ['sugar_g', 'double precision'],
  ['sodium_mg', 'double precision'],
  ['goal_calories', 'integer'],
  ['goal_protein_g', 'double precision'],
  ['goal_carbs_g', 'double precision'],
  ['goal_fat_g', 'double precision'],
  ['meals_json', 'jsonb'],
  ['source', 'text'],
  ['logged_complete', 'boolean'],
  ['weight_kg', 'numeric(5,2)'],
  ['created_at', 'timestamp with time zone'],
  ['updated_at', 'timestamp with time zone'],
];
const POST_04_COLUMNS = [...PRE_04_COLUMNS, ['maintenance_calories', 'integer']];

const GOAL_ROW_1025 = {
  effective_from: '2026-10-25',
  target_weight_kg: '100.0',
  base_calories: 2620,
  cycling_kj_factor: '1.00',
  protein_g: '180.0',
};
const GOAL_ROW_1028 = {
  effective_from: '2026-10-28',
  target_weight_kg: '100.0',
  base_calories: 1900,
  cycling_kj_factor: '1.00',
  protein_g: '180.0',
};

const URL_ = process.env.TEST_DATABASE_URL;

let admin;
function adminPool() {
  if (!admin) {
    assert.ok(URL_, 'TEST_DATABASE_URL must be set for the integration suite');
    admin = new pg.Pool({ connectionString: URL_, max: 2 });
  }
  return admin;
}
async function q(sql, params) {
  return (await adminPool().query(sql, params)).rows;
}
function readSql(file) {
  assert.ok(fs.existsSync(file), `${path.relative(REPO, file)} must exist`);
  return fs.readFileSync(file, 'utf8');
}
async function ledgerNames() {
  return (await q('SELECT name FROM public.schema_migrations ORDER BY name')).map((r) => r.name);
}
async function attributes(rel) {
  return (
    await q(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [rel],
    )
  ).map((r) => [r.name, r.type]);
}
async function viewDef() {
  const [{ def }] = await q(`SELECT pg_get_viewdef('public.nutrition_daily'::regclass) AS def`);
  return def;
}
async function goalsWithout() {
  return q(
    `SELECT effective_from::text AS effective_from, target_weight_kg::text AS target_weight_kg,
            base_calories, cycling_kj_factor::text AS cycling_kj_factor, protein_g::text AS protein_g
       FROM public.nutrition_goals ORDER BY effective_from`,
  );
}
async function goalsWith() {
  return q(
    `SELECT effective_from::text AS effective_from, target_weight_kg::text AS target_weight_kg,
            base_calories, cycling_kj_factor::text AS cycling_kj_factor, protein_g::text AS protein_g,
            maintenance_calories
       FROM public.nutrition_goals ORDER BY effective_from`,
  );
}

// Baseline plus every migration that sorts before 04 (the state migration 04
// is applied to on the Pi).
async function installBefore04() {
  await q(readSql(BASELINE_SQL));
  for (const f of migrationFiles()) {
    if (path.basename(f) < '2026-11_04') await q(readSql(f));
  }
}

async function loadFixtureIntoLegacy() {
  const text = readSql(FIXTURE);
  const marker = 'INSERT INTO public.nutrition_daily (';
  assert.equal(text.split(marker).length, 2, 'fixture must contain exactly one INSERT INTO public.nutrition_daily (');
  await q(text.replace(marker, 'INSERT INTO public.nutrition_daily_legacy ('));
}

async function insertFood(eatenAt) {
  const { rows } = await adminPool().query(
    `INSERT INTO public.food_log
       (eaten_at, meal, description, calories, protein_g, carbs_g, fat_g, confidence, match_source, created_via)
     VALUES ($1, 'lunch', 't1 maintenance item', 500, 40, 50, 15, 'high', 'estimate', 'manual')
     RETURNING day::text AS day`,
    [eatenAt],
  );
  return rows[0].day;
}

// start_time is UTC; the view maps it to America/Los_Angeles days.
async function insertRide(startTimeUtc, kj) {
  const [{ id }] = await q(
    `INSERT INTO public.workouts_raw (source, external_id, start_time, sport_type, kj, device_watts)
     VALUES ('strava', $1, $2, 'Ride', $3, true) RETURNING id`,
    [`t1-maint-${startTimeUtc}`, startTimeUtc, kj],
  );
  await q(
    `INSERT INTO public.workout_summary (workout_id, sport_type, device_watts, kj, start_time)
     VALUES ($1, 'Ride', true, $2, $3)`,
    [id, kj, startTimeUtc],
  );
}

// Food on 2026-10-27 (1000 kJ ride), 2026-10-28 (1000 kJ ride), 2026-10-29 (no ride).
async function seedDays() {
  await insertRide('2026-10-27 18:00:00', 1000);
  await insertRide('2026-10-28 18:00:00', 1000);
  assert.equal(await insertFood('2026-10-27T12:00:00-07:00'), '2026-10-27');
  assert.equal(await insertFood('2026-10-28T12:00:00-07:00'), '2026-10-28');
  assert.equal(await insertFood('2026-10-29T12:00:00-07:00'), '2026-10-29');
}

async function viewDay(day) {
  const rows = await q(
    `SELECT day::text AS day, source, goal_calories, maintenance_calories
       FROM public.nutrition_daily WHERE day = $1`,
    [day],
  );
  assert.equal(rows.length, 1, `expected one nutrition_daily row for ${day}, got ${JSON.stringify(rows)}`);
  return rows[0];
}

async function assertRolesCanSelectView({ withMaintenance }) {
  const cols = withMaintenance ? 'day, goal_calories, maintenance_calories' : 'day, goal_calories';
  const writer = await writerPool();
  const w = await writer.query(`SELECT current_user AS u, (SELECT count(*)::int FROM (SELECT ${cols} FROM public.nutrition_daily) s) AS n`);
  assert.equal(w.rows[0].u, 'nutrition_writer');
  assert.ok(w.rows[0].n >= 1, 'nutrition_writer read no nutrition_daily rows');
  const dash = await dashboardPool();
  const d = await dash.query(`SELECT current_user AS u, (SELECT count(*)::int FROM (SELECT ${cols} FROM public.nutrition_daily) s) AS n`);
  assert.equal(d.rows[0].u, 'dashboard_ro');
  assert.ok(d.rows[0].n >= 1, 'dashboard_ro read no nutrition_daily rows');
  await closePools();
}

describe('maintenance_calories (migration 04)', () => {
  before(() => {
    assert.ok(URL_, 'TEST_DATABASE_URL must be set for the integration suite');
  });

  after(async () => {
    await closePools();
    if (admin) await admin.end();
  });

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------
  describe('migration files', () => {
    test('up and down exist; upgradeInstall() applies 04 after 03 and skips the down file', () => {
      readSql(UP);
      readSql(DOWN);
      const names = migrationFiles().map((f) => path.basename(f));
      assert.ok(names.includes(`${MIGRATION_NAME}.sql`), `migrationFiles() lacks ${MIGRATION_NAME}.sql`);
      assert.ok(!names.includes(`${MIGRATION_NAME}.down.sql`));
      assert.ok(
        names.indexOf('2026-11_03_dashboard_role.sql') < names.indexOf(`${MIGRATION_NAME}.sql`),
        'migration 04 must sort after migration 03',
      );
    });

    test('no psql meta-commands in the migration files', () => {
      for (const f of [UP, DOWN]) {
        const metas = readSql(f)
          .split(/\r?\n/)
          .filter((l) => /^\s*\\/.test(l));
        assert.deepEqual(metas, [], `${path.basename(f)} has psql meta-commands`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // (a)-(e), (g) on both install paths
  // -------------------------------------------------------------------------
  const INSTALLS = { upgradeInstall: () => upgradeInstall(), freshInstall: () => freshInstall() };

  for (const [installName, install] of Object.entries(INSTALLS)) {
    describe(`after ${installName}()`, () => {
      before(async () => {
        await closePools();
        await resetDb();
        await install();
        await loadFixtureIntoLegacy();
        await seedDays();
      });

      after(async () => {
        await closePools();
      });

      test('(a) nutrition_daily keeps every column in order and gains a trailing maintenance_calories integer', async () => {
        assert.deepEqual(await attributes('public.nutrition_daily'), POST_04_COLUMNS);
      });

      test('(b) nutrition_goals.maintenance_calories is integer NOT NULL', async () => {
        const rows = await q(
          `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
             FROM pg_attribute a
            WHERE a.attrelid = 'public.nutrition_goals'::regclass
              AND a.attname = 'maintenance_calories' AND NOT a.attisdropped`,
        );
        assert.deepEqual(rows, [{ type: 'integer', notnull: true }]);
      });

      test('(b) goals: 2026-10-25 keeps its goal fields and gains 2620; 2026-10-28 is base 1900, maintenance 2620', async () => {
        assert.deepEqual(await goalsWith(), [
          { ...GOAL_ROW_1025, maintenance_calories: 2620 },
          { ...GOAL_ROW_1028, maintenance_calories: 2620 },
        ]);
      });

      test('(c) 2026-10-27, 1000 kJ powered Ride: goal 3620, maintenance 3620', async () => {
        assert.deepEqual(await viewDay('2026-10-27'), {
          day: '2026-10-27',
          source: 'food_log',
          goal_calories: 3620,
          maintenance_calories: 3620,
        });
      });

      test('(c) 2026-10-28, 1000 kJ powered Ride: goal 2900, maintenance 3620', async () => {
        assert.deepEqual(await viewDay('2026-10-28'), {
          day: '2026-10-28',
          source: 'food_log',
          goal_calories: 2900,
          maintenance_calories: 3620,
        });
      });

      test('(c) 2026-10-29, no ride: goal 1900, maintenance 2620', async () => {
        assert.deepEqual(await viewDay('2026-10-29'), {
          day: '2026-10-29',
          source: 'food_log',
          goal_calories: 1900,
          maintenance_calories: 2620,
        });
      });

      test('(d) legacy-table days return maintenance_calories NULL (typed integer)', async () => {
        const [legacyDay] = await q(
          `SELECT maintenance_calories, pg_typeof(maintenance_calories)::text AS t, source
             FROM public.nutrition_daily WHERE day = '2026-01-15'`,
        );
        assert.ok(legacyDay, 'legacy day 2026-01-15 missing from nutrition_daily');
        assert.notEqual(legacyDay.source, 'food_log');
        assert.equal(legacyDay.maintenance_calories, null);
        assert.equal(legacyDay.t, 'integer');
        const [{ n, nonnull }] = await q(
          `SELECT count(*)::int AS n, count(maintenance_calories)::int AS nonnull
             FROM public.nutrition_daily WHERE source IS DISTINCT FROM 'food_log'`,
        );
        assert.equal(n, FIXTURE_ROWS);
        assert.equal(nonnull, 0);
      });

      test('(e) the ledger records migration 04 and re-applying it raises "already applied"', async () => {
        assert.ok((await ledgerNames()).includes(MIGRATION_NAME), `ledger lacks ${MIGRATION_NAME}`);
        await assert.rejects(q(readSql(UP)), (err) => /already applied/i.test(err.message));
        assert.deepEqual((await goalsWith()).map((r) => r.effective_from), ['2026-10-25', '2026-10-28']);
      });

      test('(f) nutrition_writer and dashboard_ro can SELECT nutrition_daily including maintenance_calories', async () => {
        await assertRolesCanSelectView({ withMaintenance: true });
      });

      test('(g) a goals row with maintenance_calories 100 fails the CHECK; NULL fails NOT NULL', async () => {
        await assert.rejects(
          q(
            `INSERT INTO public.nutrition_goals (effective_from, base_calories, maintenance_calories)
             VALUES ('2030-01-01', 2000, 100)`,
          ),
          (err) => err.code === '23514',
        );
        await assert.rejects(
          q(
            `INSERT INTO public.nutrition_goals (effective_from, base_calories, maintenance_calories)
             VALUES ('2030-01-02', 2000, NULL)`,
          ),
          (err) => err.code === '23502',
        );
        const [{ n }] = await q(
          `SELECT count(*)::int AS n FROM public.nutrition_goals WHERE effective_from >= '2030-01-01'`,
        );
        assert.equal(n, 0);
      });
    });
  }

  // -------------------------------------------------------------------------
  // (f) down script
  // -------------------------------------------------------------------------
  describe('(f) down script on the pre-04 upgrade path', () => {
    let catalogBefore;
    let viewDefBefore;

    before(async () => {
      await closePools();
      await resetDb();
      await installBefore04();
      assert.ok(!(await ledgerNames()).includes(MIGRATION_NAME), 'pre-04 install already has migration 04');
      await seedDays();
      catalogBefore = JSON.parse(JSON.stringify(await catalogSnapshot()));
      viewDefBefore = await viewDef();
      assert.deepEqual(await attributes('public.nutrition_daily'), PRE_04_COLUMNS);
      assert.deepEqual(await goalsWithout(), [GOAL_ROW_1025]);

      await q(readSql(UP));
      assert.deepEqual(await attributes('public.nutrition_daily'), POST_04_COLUMNS);
      await assertRolesCanSelectView({ withMaintenance: true });

      await q(readSql(DOWN));
    });

    after(async () => {
      await closePools();
    });

    test('nutrition_daily has the pre-04 columns and view definition again', async () => {
      assert.deepEqual(await attributes('public.nutrition_daily'), PRE_04_COLUMNS);
      assert.equal(await viewDef(), viewDefBefore);
    });

    test('the 2026-10-28 row is gone, the column is dropped, and the 2026-10-25 row is unchanged', async () => {
      assert.deepEqual(await goalsWithout(), [GOAL_ROW_1025]);
      const [{ n }] = await q(
        `SELECT count(*)::int AS n FROM pg_attribute
          WHERE attrelid = 'public.nutrition_goals'::regclass AND attname = 'maintenance_calories' AND NOT attisdropped`,
      );
      assert.equal(n, 0, 'nutrition_goals.maintenance_calories still exists');
    });

    test('the ledger no longer lists migration 04', async () => {
      assert.ok(!(await ledgerNames()).includes(MIGRATION_NAME), 'ledger row not removed');
    });

    test('goals fall back to the 2026-10-25 row: 2026-10-28 with a 1000 kJ ride is goal 3620 again', async () => {
      const [r] = await q(
        `SELECT goal_calories FROM public.nutrition_daily WHERE day = '2026-10-28'`,
      );
      assert.equal(r.goal_calories, 3620);
    });

    test('the catalog (columns and grants of every relation) matches the pre-04 catalog', async () => {
      assert.deepEqual(JSON.parse(JSON.stringify(await catalogSnapshot())), catalogBefore);
    });

    test('nutrition_writer and dashboard_ro can still SELECT nutrition_daily', async () => {
      await assertRolesCanSelectView({ withMaintenance: false });
    });
  });
});
