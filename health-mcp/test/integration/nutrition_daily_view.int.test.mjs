// T8 spec: goals, day status and the nutrition_daily view
// (migration health_data_hub/db/migrations/2026-11_02_nutrition_daily_view.sql,
// build-plan §4.3 with the goal design replaced by PLAN.md D5, precedence per D2).
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Fixture: health-mcp/test/fixtures/nutrition_daily_rows.sql (synthetic legacy
// rows written for the baseline table public.nutrition_daily). Installs that
// already have the view load it into public.nutrition_daily_legacy instead.
//
// Behaviour tests (b)-(f) and (j) run against both upgradeInstall() and
// freshInstall(), because catalogSnapshot() does not see view definitions and
// schema.sql must produce the migration's end state.

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
  readonlyPool,
  closePools,
} from '../helpers/testdb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const DB_DIR = path.join(REPO, 'health_data_hub/db');
const SCHEMA_SQL = path.join(DB_DIR, 'schema.sql');
const BASELINE_SQL = path.join(DB_DIR, 'baseline/schema_2026-10.sql');
const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');
const MIGRATION_NAME = '2026-11_02_nutrition_daily_view';
const UP = path.join(MIGRATIONS_DIR, `${MIGRATION_NAME}.sql`);
const DOWN = path.join(MIGRATIONS_DIR, `${MIGRATION_NAME}.down.sql`);
const FIXTURE = path.join(HERE, '../fixtures/nutrition_daily_rows.sql');
const FIXTURE_ROWS = 10;

// The legacy table's columns, in table order, with their declared types.
const LEGACY_COLUMNS = [
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
const COLS = LEGACY_COLUMNS.map(([c]) => c);

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
async function relkind(qualified) {
  const rows = await q(
    `SELECT c.relkind::text AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname || '.' || c.relname = $1`,
    [qualified],
  );
  return rows.length ? rows[0].k : null;
}
async function indexOn(indexName) {
  const rows = await q(
    `SELECT t.relname AS tbl FROM pg_index i
       JOIN pg_class x ON x.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = x.relnamespace
      WHERE n.nspname = 'public' AND x.relname = $1`,
    [indexName],
  );
  return rows.length ? rows[0].tbl : null;
}
async function ledgerNames() {
  return (await q('SELECT name FROM public.schema_migrations ORDER BY name')).map((r) => r.name);
}

// Baseline plus every migration that sorts before 02 (the state migration 02
// is applied to on the Pi).
async function installBefore02() {
  await q(readSql(BASELINE_SQL));
  for (const f of migrationFiles()) {
    if (path.basename(f) < '2026-11_02') await q(readSql(f));
  }
  assert.equal(await relkind('public.nutrition_daily'), 'r', 'pre-02 install must have the nutrition_daily table');
}

async function loadFixture(target) {
  const text = readSql(FIXTURE);
  const marker = 'INSERT INTO public.nutrition_daily (';
  assert.equal(text.split(marker).length, 2, 'fixture must contain exactly one INSERT INTO public.nutrition_daily (');
  await q(target === 'legacy' ? text.replace(marker, 'INSERT INTO public.nutrition_daily_legacy (') : text);
}

// Everything a reader can observe about a relation's rows: SELECT * values and
// field metadata in order, each row's text form, and pg_typeof of every column.
async function rowsSnapshot(rel) {
  const typeofs = COLS.map((c) => `pg_typeof(n.${c})::text AS "typeof_${c}"`).join(',\n       ');
  const res = await adminPool().query(
    `SELECT n.*, n::text AS row_text,
       ${typeofs}
       FROM ${rel} n ORDER BY n.day`,
  );
  return JSON.parse(
    JSON.stringify({
      fields: res.fields.map((f) => [f.name, f.dataTypeID]),
      rows: res.rows,
    }),
  );
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

// One food_log row; override any column.
async function insertFood(overrides = {}) {
  const row = {
    eaten_at: '2026-10-26T12:00:00-07:00',
    meal: 'lunch',
    description: 't8 item',
    calories: 100,
    protein_g: 10,
    carbs_g: 10,
    fat_g: 2,
    confidence: 'high',
    match_source: 'estimate',
    created_via: 'manual',
    ...overrides,
  };
  const cols = Object.keys(row);
  const { rows } = await adminPool().query(
    `INSERT INTO public.food_log (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id, day::text AS day`,
    cols.map((c) => row[c]),
  );
  return rows[0];
}

async function insertWorkout({ sport_type, device_watts, kj, start_time }) {
  const [{ id }] = await q(
    `INSERT INTO public.workouts_raw (source, external_id, start_time, sport_type, kj, device_watts)
     VALUES ('strava', $1, $2, $3, $4, $5) RETURNING id`,
    [`t8-${start_time}-${sport_type}`, start_time, sport_type, kj, device_watts],
  );
  await q(
    `INSERT INTO public.workout_summary (workout_id, sport_type, device_watts, kj, start_time)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, sport_type, device_watts, kj, start_time],
  );
}

async function dayRow(day) {
  return q(
    `SELECT day::text AS day, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
            goal_calories, goal_protein_g, goal_carbs_g, goal_fat_g,
            meals_json, source, logged_complete, weight_kg
       FROM public.nutrition_daily WHERE day = $1`,
    [day],
  );
}

describe('nutrition_daily view (migration 02)', () => {
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
    test('up and down exist; upgradeInstall() applies 02 after 01 and skips the down file', () => {
      readSql(UP);
      readSql(DOWN);
      const names = migrationFiles().map((f) => path.basename(f));
      assert.ok(names.includes(`${MIGRATION_NAME}.sql`));
      assert.ok(!names.includes(`${MIGRATION_NAME}.down.sql`));
      assert.ok(names.indexOf('2026-11_01_food_log.sql') < names.indexOf(`${MIGRATION_NAME}.sql`));
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
  // (a) the migration is invisible to readers while food_log is empty
  // -------------------------------------------------------------------------
  describe('(a) baseline + fixture, empty food_log: nutrition_daily identical before and after', () => {
    let before02;
    let after02;
    let attrsBefore;
    let attrsAfter;

    before(async () => {
      await closePools();
      await resetDb();
      await installBefore02();
      await loadFixture('baseline');
      before02 = await rowsSnapshot('public.nutrition_daily');
      attrsBefore = await attributes('public.nutrition_daily');
      await q(readSql(UP));
      after02 = await rowsSnapshot('public.nutrition_daily');
      attrsAfter = await attributes('public.nutrition_daily');
    });

    test('the fixture loaded', () => {
      assert.equal(before02.rows.length, FIXTURE_ROWS);
    });

    test('nutrition_daily is now a view over table nutrition_daily_legacy', async () => {
      assert.equal(await relkind('public.nutrition_daily'), 'v');
      assert.equal(await relkind('public.nutrition_daily_legacy'), 'r');
      const [{ n }] = await q('SELECT count(*)::int AS n FROM public.food_log');
      assert.equal(n, 0);
    });

    test('same column names, order and declared types (weight_kg numeric(5,2))', () => {
      assert.deepEqual(attrsBefore, LEGACY_COLUMNS);
      assert.deepEqual(attrsAfter, LEGACY_COLUMNS);
    });

    test('SELECT *, row text and pg_typeof of every column are identical, in day order', () => {
      assert.deepEqual(after02.fields, before02.fields);
      assert.deepEqual(after02.rows, before02.rows);
    });

    test('the legacy rows moved to nutrition_daily_legacy unchanged, PK index renamed', async () => {
      assert.deepEqual(await rowsSnapshot('public.nutrition_daily_legacy'), before02);
      assert.equal(await indexOn('nutrition_daily_legacy_pkey'), 'nutrition_daily_legacy');
      assert.equal(await indexOn('nutrition_daily_pkey'), null);
    });

    test('the migration records itself and refuses to re-apply', async () => {
      assert.ok((await ledgerNames()).includes(MIGRATION_NAME));
      await assert.rejects(q(readSql(UP)), (err) => /already applied/i.test(err.message));
    });
  });

  // -------------------------------------------------------------------------
  // (b)-(f), (j) behaviour on both install paths
  // -------------------------------------------------------------------------
  const INSTALLS = { upgradeInstall: () => upgradeInstall(), freshInstall: () => freshInstall() };

  for (const [installName, install] of Object.entries(INSTALLS)) {
    describe(`after ${installName}() + fixture in nutrition_daily_legacy`, () => {
      before(async () => {
        await closePools();
        await resetDb();
        await install();
        await loadFixture('legacy');
      });

      after(async () => {
        await closePools();
      });

      test('with an empty food_log the view returns exactly the legacy rows', async () => {
        assert.equal(await relkind('public.nutrition_daily'), 'v');
        const view = await rowsSnapshot('public.nutrition_daily');
        const legacy = await rowsSnapshot('public.nutrition_daily_legacy');
        assert.equal(view.rows.length, FIXTURE_ROWS);
        assert.deepEqual(view, legacy);
      });

      test('re-applying migration 02 raises "already applied"', async () => {
        await assert.rejects(q(readSql(UP)), (err) => /already applied/i.test(err.message));
      });

      // ---------------------------------------------------------------------
      // (b), (c) per-day precedence, no double count, soft delete
      // ---------------------------------------------------------------------
      describe('(b)-(c) a legacy day with food_log rows', () => {
        const DAY = '2026-01-15'; // legacy myfitnesspal row: 2100 kcal
        let legacyRowText;
        const ids = [];

        before(async () => {
          [{ t: legacyRowText }] = await q(
            'SELECT n::text AS t FROM public.nutrition_daily n WHERE day = $1',
            [DAY],
          );
        });

        test('(b) returns source=food_log and the food_log sums, not legacy + food_log', async () => {
          for (const it of [
            { eaten_at: '2026-01-15T08:00-08:00', meal: 'breakfast', calories: 400, protein_g: 20.5, carbs_g: 50, fat_g: 10, fiber_g: 3, sodium_mg: 200 },
            { eaten_at: '2026-01-15T12:30-08:00', meal: 'lunch', calories: 600.4, protein_g: 40, carbs_g: 60.2, fat_g: 20, fiber_g: 5, sodium_mg: 800.5 },
            { eaten_at: '2026-01-15T15:30-08:00', meal: 'snack', calories: 150, protein_g: 5, carbs_g: 20, fat_g: 5, sodium_mg: 100 },
          ]) {
            const { id, day } = await insertFood(it);
            assert.equal(day, DAY);
            ids.push(id);
          }
          const rows = await dayRow(DAY);
          assert.equal(rows.length, 1, `expected one row for ${DAY}, got ${JSON.stringify(rows)}`);
          const r = rows[0];
          assert.equal(r.source, 'food_log');
          assert.equal(r.calories, 1150);
          assert.equal(r.protein_g, 65.5);
          assert.equal(r.carbs_g, 130.2);
          assert.equal(r.fat_g, 35);
          assert.equal(r.fiber_g, 8);
          assert.equal(r.sugar_g, null);
          assert.equal(r.sodium_mg, 1100.5);
          assert.equal(r.weight_kg, null);
          const [{ n }] = await q('SELECT count(*)::int AS n FROM public.nutrition_daily');
          assert.equal(n, FIXTURE_ROWS, 'a replaced legacy day must not add a row');
        });

        test('(c) soft-deleting those rows brings the legacy row back unchanged', async () => {
          await q('UPDATE public.food_log SET deleted_at = now() WHERE id = ANY($1::bigint[])', [ids]);
          const rows = await q('SELECT n::text AS t, source FROM public.nutrition_daily n WHERE day = $1', [DAY]);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].source, 'myfitnesspal');
          assert.equal(rows[0].t, legacyRowText);
        });
      });

      // ---------------------------------------------------------------------
      // (d) meals_json keys
      // ---------------------------------------------------------------------
      test('(d) meals_json keys come only from breakfast, lunch, dinner, snacks', async () => {
        const DAY = '2026-11-05';
        await insertFood({ eaten_at: '2026-11-05T08:00-08:00', meal: 'breakfast' });
        await insertFood({ eaten_at: '2026-11-05T12:30-08:00', meal: 'lunch' });
        await insertFood({ eaten_at: '2026-11-05T15:30-08:00', meal: 'snack' });
        await insertFood({ eaten_at: '2026-11-05T16:30-08:00', meal: 'snack' });
        await insertFood({ eaten_at: '2026-11-05T19:00-08:00', meal: 'dinner' });
        const rows = await dayRow(DAY);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source, 'food_log');
        const meals = rows[0].meals_json;
        assert.ok(meals && typeof meals === 'object' && !Array.isArray(meals), `meals_json was ${JSON.stringify(meals)}`);
        assert.deepEqual(Object.keys(meals).sort(), ['breakfast', 'dinner', 'lunch', 'snacks']);
      });

      // ---------------------------------------------------------------------
      // (e) D5 goals: base + cycling kJ, no Oura
      // ---------------------------------------------------------------------
      describe('(e) goals from the D5 seed row', () => {
        test('nutrition_goals holds the seed row', async () => {
          const rows = await q(
            `SELECT effective_from::text AS effective_from, target_weight_kg::text AS target_weight_kg,
                    base_calories, cycling_kj_factor::text AS cycling_kj_factor, protein_g::text AS protein_g
               FROM public.nutrition_goals ORDER BY effective_from`,
          );
          assert.deepEqual(rows, [
            {
              effective_from: '2026-10-25',
              target_weight_kg: '100.0',
              base_calories: 2620,
              cycling_kj_factor: '1.00',
              protein_g: '180.0',
            },
          ]);
        });

        test('powered Ride kJ add to base calories; EBikeRide and NULL-kJ rides add nothing', async () => {
          await insertWorkout({ sport_type: 'Ride', device_watts: true, kj: 400, start_time: '2026-10-26 07:00:00' });
          await insertWorkout({ sport_type: 'Ride', device_watts: true, kj: 250, start_time: '2026-10-26 17:00:00' });
          await insertWorkout({ sport_type: 'EBikeRide', device_watts: false, kj: 300, start_time: '2026-10-26 12:00:00' });
          await insertWorkout({ sport_type: 'Ride', device_watts: true, kj: null, start_time: '2026-10-26 18:30:00' });
          await insertFood({ eaten_at: '2026-10-26T12:00-07:00' });
          await insertFood({ eaten_at: '2026-10-27T12:00-07:00' });

          const [ride] = await dayRow('2026-10-26');
          assert.equal(ride.source, 'food_log');
          assert.equal(ride.goal_calories, 3270);

          const [rest] = await dayRow('2026-10-27');
          assert.equal(rest.source, 'food_log');
          assert.equal(rest.goal_calories, 2620);

          for (const r of [ride, rest]) {
            assert.equal(r.goal_protein_g, 180);
            assert.equal(r.goal_carbs_g, null);
            assert.equal(r.goal_fat_g, null);
          }
        });

        test('the view definition does not mention oura', async () => {
          const [{ def }] = await q(`SELECT pg_get_viewdef('public.nutrition_daily'::regclass) AS def`);
          assert.ok(def && def.length > 0);
          assert.doesNotMatch(def, /oura/i);
        });
      });

      // ---------------------------------------------------------------------
      // (f) logged_complete
      // ---------------------------------------------------------------------
      test('(f) logged_complete comes from nutrition_day_status for food_log days', async () => {
        const DAY = '2025-12-10'; // legacy row has logged_complete = true
        await insertFood({ eaten_at: '2025-12-10T12:00-08:00' });
        await q(`INSERT INTO public.nutrition_day_status (day, logged_complete) VALUES ($1, false)`, [DAY]);
        const [r] = await dayRow(DAY);
        assert.equal(r.source, 'food_log');
        assert.equal(r.logged_complete, false);

        await q(`INSERT INTO public.nutrition_day_status (day, logged_complete) VALUES ('2026-11-05', true)`);
        const [d] = await dayRow('2026-11-05');
        assert.equal(d.logged_complete, true);
      });

      // ---------------------------------------------------------------------
      // (j) claude_readonly
      // ---------------------------------------------------------------------
      test('(j) claude_readonly can SELECT nutrition_daily and nutrition_daily_legacy', async () => {
        const ro = await readonlyPool();
        const { rows: who } = await ro.query('SELECT current_user AS u');
        assert.equal(who[0].u, 'claude_readonly');
        const a = await ro.query('SELECT count(*)::int AS n FROM public.nutrition_daily');
        assert.ok(a.rows[0].n >= FIXTURE_ROWS);
        const b = await ro.query('SELECT count(*)::int AS n FROM public.nutrition_daily_legacy');
        assert.equal(b.rows[0].n, FIXTURE_ROWS);
      });
    });
  }

  // -------------------------------------------------------------------------
  // (g) init_db equivalent
  // -------------------------------------------------------------------------
  describe('(g) schema.sql', () => {
    test('freshInstall() twice in a row succeeds and leaves one seed goal row', async () => {
      await closePools();
      await resetDb();
      await freshInstall();
      await freshInstall();
      assert.equal(await relkind('public.nutrition_daily'), 'v');
      assert.equal(await relkind('public.nutrition_daily_legacy'), 'r');
      const [{ n }] = await q('SELECT count(*)::int AS n FROM public.nutrition_goals');
      assert.equal(n, 1);
    });

    test('the legacy table block and its ALTER TABLE ... ADD COLUMN target nutrition_daily_legacy', () => {
      const text = readSql(SCHEMA_SQL);
      assert.match(text, /ALTER TABLE\s+(?:public\.)?nutrition_daily_legacy\b[\s\S]*?ADD COLUMN IF NOT EXISTS weight_kg/i);
      assert.doesNotMatch(text, /ALTER TABLE\s+(?:public\.)?nutrition_daily\b/i);
      assert.doesNotMatch(text, /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?nutrition_daily\b/i);
      assert.match(text, /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?nutrition_daily_legacy\b/i);
    });
  });

  // -------------------------------------------------------------------------
  // (h) catalog parity (T2)
  // -------------------------------------------------------------------------
  describe('(h) catalog parity', () => {
    test('freshInstall() and upgradeInstall() produce the same catalog, ledger and PK index name', async () => {
      await closePools();
      await resetDb();
      await freshInstall();
      const fresh = JSON.parse(JSON.stringify(await catalogSnapshot()));
      const freshLedger = await ledgerNames();
      const freshPk = await indexOn('nutrition_daily_legacy_pkey');
      await resetDb();
      await upgradeInstall();
      const upgraded = JSON.parse(JSON.stringify(await catalogSnapshot()));
      const upgradedLedger = await ledgerNames();
      const upgradedPk = await indexOn('nutrition_daily_legacy_pkey');

      for (const [rel, kind] of [
        ['nutrition_goals', 'r'],
        ['nutrition_day_status', 'r'],
        ['nutrition_daily_legacy', 'r'],
        ['nutrition_daily', 'v'],
      ]) {
        const row = fresh.find((r) => r.relname === rel);
        assert.ok(row, `fresh install lacks ${rel}`);
        assert.equal(row.relkind, kind, `${rel} relkind`);
      }
      assert.deepEqual(upgraded, fresh);
      assert.ok(upgradedLedger.includes(MIGRATION_NAME), 'migration 02 must record itself in schema_migrations');
      assert.deepEqual(upgradedLedger, freshLedger);
      assert.equal(freshPk, 'nutrition_daily_legacy');
      assert.equal(upgradedPk, 'nutrition_daily_legacy');
    });
  });

  // -------------------------------------------------------------------------
  // (i) down script
  // -------------------------------------------------------------------------
  describe('(i) down script', () => {
    let before02;
    let attrsBefore;
    let catalogBefore;

    before(async () => {
      await closePools();
      await resetDb();
      await installBefore02();
      await loadFixture('baseline');
      before02 = await rowsSnapshot('public.nutrition_daily');
      attrsBefore = await attributes('public.nutrition_daily');
      catalogBefore = JSON.parse(JSON.stringify(await catalogSnapshot()));
      await q(readSql(UP));
      await insertFood({ eaten_at: '2026-01-15T12:00-08:00', description: 'survives the down script' });
      await q(readSql(DOWN));
    });

    test('restores table nutrition_daily with its PK index name and drops the 02 objects', async () => {
      assert.equal(await relkind('public.nutrition_daily'), 'r');
      assert.equal(await relkind('public.nutrition_daily_legacy'), null);
      assert.equal(await relkind('public.nutrition_goals'), null);
      assert.equal(await relkind('public.nutrition_day_status'), null);
      assert.equal(await indexOn('nutrition_daily_pkey'), 'nutrition_daily');
      assert.ok(!(await ledgerNames()).includes(MIGRATION_NAME), 'ledger row not removed');
    });

    test('leaves food_log and its rows alone', async () => {
      const [{ n }] = await q('SELECT count(*)::int AS n FROM public.food_log');
      assert.equal(n, 1);
    });

    test('(a) passes again: rows, row text, pg_typeof and declared types are identical', async () => {
      assert.deepEqual(await attributes('public.nutrition_daily'), attrsBefore);
      assert.deepEqual(await rowsSnapshot('public.nutrition_daily'), before02);
    });

    test('the catalog matches the pre-02 catalog', async () => {
      assert.deepEqual(JSON.parse(JSON.stringify(await catalogSnapshot())), catalogBefore);
    });
  });
});
