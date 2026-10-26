// T4 spec: food_log, my_foods, audit and nutrition_writer schema
// (migration health_data_hub/db/migrations/2026-11_01_food_log.sql, build-plan §4.2).
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Helper interface assumed beyond T2/T3 (health-mcp/test/helpers/testdb.mjs):
//   writerPool()   pg.Pool (or Promise of one) logged in as nutrition_writer.
//                  The helper gives nutrition_writer a known test password
//                  after install (freshInstall()/upgradeInstall(), or inside
//                  writerPool() itself); it validates TEST_DATABASE_URL like
//                  every other entry point. Tests call it only after an install.
//
// Behaviour tests (a)-(i) run against both upgradeInstall() and freshInstall(),
// because catalogSnapshot() does not see triggers, CHECKs or functions and
// schema.sql must mirror the migration's end state.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import * as testdb from '../helpers/testdb.mjs';

const { resetDb, freshInstall, upgradeInstall, migrationFiles, catalogSnapshot, readonlyPool, closePools } =
  testdb;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const MIGRATIONS_DIR = path.join(REPO, 'health_data_hub/db/migrations');
const UP = path.join(MIGRATIONS_DIR, '2026-11_01_food_log.sql');
const DOWN = path.join(MIGRATIONS_DIR, '2026-11_01_food_log.down.sql');
const MIGRATION_NAME = '2026-11_01_food_log';
const MIGRATION_02 = '2026-11_02_nutrition_daily_view';
const DOWN_02 = path.join(MIGRATIONS_DIR, `${MIGRATION_02}.down.sql`);

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
async function relExists(qualified) {
  const [{ oid }] = await q('SELECT to_regclass($1)::text AS oid', [qualified]);
  return oid !== null;
}
async function roleExists(name) {
  const rows = await q('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  return rows.length === 1;
}
async function ledgerNames() {
  return (await q('SELECT name FROM public.schema_migrations ORDER BY name')).map((r) => r.name);
}
async function getWriterPool() {
  assert.equal(typeof testdb.writerPool, 'function', 'testdb.mjs must export writerPool()');
  return await testdb.writerPool();
}

// A minimal valid food_log row; override any column.
function item(overrides = {}) {
  return {
    eaten_at: '2026-10-25T12:00:00-07:00',
    meal: 'lunch',
    description: 'test item',
    calories: 100,
    protein_g: 10,
    carbs_g: 10,
    fat_g: 2,
    confidence: 'high',
    match_source: 'estimate',
    created_via: 'manual',
    ...overrides,
  };
}
async function insertItem(queryable, overrides = {}) {
  const row = item(overrides);
  const cols = Object.keys(row);
  const params = cols.map((_, i) => `$${i + 1}`);
  const { rows } = await queryable.query(
    `INSERT INTO public.food_log (${cols.join(', ')}) VALUES (${params.join(', ')})
     RETURNING id, day::text AS day`,
    cols.map((c) => row[c]),
  );
  return rows[0];
}
const adminQueryable = { query: (sql, params) => adminPool().query(sql, params) };

const INSTALLS = { upgradeInstall: () => upgradeInstall(), freshInstall: () => freshInstall() };

describe('food_log schema (migration 01)', () => {
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
    test('up and down exist; upgradeInstall() picks up the up file after the ledger', () => {
      readSql(UP);
      readSql(DOWN);
      const names = migrationFiles().map((f) => path.basename(f));
      assert.ok(names.includes('2026-11_01_food_log.sql'));
      assert.ok(!names.includes('2026-11_01_food_log.down.sql'));
      assert.ok(names.indexOf('2026-11_00_migration_ledger.sql') < names.indexOf('2026-11_01_food_log.sql'));
    });

    test('no psql meta-commands and no role password in the migration files', () => {
      for (const f of [UP, DOWN]) {
        const text = readSql(f);
        const metas = text.split(/\r?\n/).filter((l) => /^\s*\\/.test(l));
        assert.deepEqual(metas, [], `${path.basename(f)} has psql meta-commands`);
        assert.doesNotMatch(text, /\bPASSWORD\b/i, `${path.basename(f)} must not set a role password`);
      }
    });
  });

  for (const [installName, install] of Object.entries(INSTALLS)) {
    describe(`after ${installName}()`, () => {
      let writer;
      let ro;

      before(async () => {
        await closePools();
        await resetDb();
        await install();
      });

      after(async () => {
        await closePools();
        writer = undefined;
        ro = undefined;
      });

      // ---------------------------------------------------------------------
      // (a)-(c) generated LA day
      // ---------------------------------------------------------------------
      describe('(a)-(c) day is the America/Los_Angeles calendar date of eaten_at', () => {
        test('(a) late evening and just after midnight PDT', async () => {
          assert.equal((await insertItem(adminQueryable, { eaten_at: '2026-10-25T23:30-07:00' })).day, '2026-10-25');
          assert.equal((await insertItem(adminQueryable, { eaten_at: '2026-10-26T00:30-07:00' })).day, '2026-10-26');
        });

        test('(b) both 01:30 instants on the DST fall-back day and 23:59 PST are 2026-11-01', async () => {
          for (const ts of ['2026-11-01T01:30-07:00', '2026-11-01T01:30-08:00', '2026-11-02T07:59Z']) {
            assert.equal((await insertItem(adminQueryable, { eaten_at: ts })).day, '2026-11-01', ts);
          }
        });

        test("(c) same as (a) with session TimeZone='UTC'", async () => {
          const client = await adminPool().connect();
          try {
            await client.query(`SET TimeZone = 'UTC'`);
            const { rows } = await client.query('SHOW TimeZone');
            assert.equal(Object.values(rows[0])[0], 'UTC');
            assert.equal((await insertItem(client, { eaten_at: '2026-10-25T23:30-07:00' })).day, '2026-10-25');
            assert.equal((await insertItem(client, { eaten_at: '2026-10-26T00:30-07:00' })).day, '2026-10-26');
          } finally {
            client.release(true);
          }
        });
      });

      // ---------------------------------------------------------------------
      // (d) CHECKs
      // ---------------------------------------------------------------------
      describe('(d) CHECK constraints', () => {
        const isCheck = (err) => err.code === '23514';

        test("rejects match_source='favorite' with NULL my_food_id", async () => {
          await assert.rejects(insertItem(adminQueryable, { match_source: 'favorite' }), isCheck);
        });

        test("rejects match_source='usda' with NULL fdc_id", async () => {
          await assert.rejects(insertItem(adminQueryable, { match_source: 'usda' }), isCheck);
        });

        test('rejects calories = -1', async () => {
          await assert.rejects(insertItem(adminQueryable, { calories: -1 }), isCheck);
        });

        test("rejects meal = 'brunch'", async () => {
          await assert.rejects(insertItem(adminQueryable, { meal: 'brunch' }), isCheck);
        });

        test('accepts favorite with my_food_id and usda with fdc_id', async () => {
          const [{ id: foodId }] = await q(
            `INSERT INTO public.my_foods (name, calories, protein_g, carbs_g, fat_g, confidence, basis)
             VALUES ($1, 200, 20, 10, 5, 'high', 'label') RETURNING id`,
            [`t4 favorite ${installName}`],
          );
          await insertItem(adminQueryable, { match_source: 'favorite', my_food_id: foodId });
          await insertItem(adminQueryable, { match_source: 'usda', fdc_id: 171287 });
        });
      });

      // ---------------------------------------------------------------------
      // (e) idempotency key
      // ---------------------------------------------------------------------
      test('(e) a duplicate (request_id, request_line) is rejected', async () => {
        const rid = crypto.randomUUID();
        await insertItem(adminQueryable, { request_id: rid, request_line: 0 });
        await insertItem(adminQueryable, { request_id: rid, request_line: 1 });
        await assert.rejects(
          insertItem(adminQueryable, { request_id: rid, request_line: 0 }),
          (err) => err.code === '23505',
        );
      });

      // ---------------------------------------------------------------------
      // (f) audit trail
      // ---------------------------------------------------------------------
      test('(f) insert, update, soft delete and restore write matching audit actions', async () => {
        const { id } = await insertItem(adminQueryable, { description: 'audited item' });
        await q('UPDATE public.food_log SET calories = 150 WHERE id = $1', [id]);
        await q('UPDATE public.food_log SET deleted_at = now() WHERE id = $1', [id]);
        await q('UPDATE public.food_log SET deleted_at = NULL WHERE id = $1', [id]);
        const rows = await q(
          `SELECT action, old_row IS NULL AS no_old, new_row IS NULL AS no_new
             FROM public.food_log_audit WHERE food_log_id = $1 ORDER BY id`,
          [id],
        );
        assert.deepEqual(
          rows.map((r) => r.action),
          ['insert', 'update', 'soft_delete', 'restore'],
        );
        assert.equal(rows[0].no_old, true, 'insert audit row has no old_row');
        assert.equal(rows[0].no_new, false, 'insert audit row has new_row');
        for (const r of rows.slice(1)) {
          assert.equal(r.no_old, false);
          assert.equal(r.no_new, false);
        }
      });

      // ---------------------------------------------------------------------
      // (g) nutrition_writer privileges
      // ---------------------------------------------------------------------
      describe('(g) as nutrition_writer', () => {
        before(async () => {
          writer = await getWriterPool();
        });

        test('is logged in as nutrition_writer', async () => {
          const { rows } = await writer.query('SELECT current_user AS u');
          assert.equal(rows[0].u, 'nutrition_writer');
        });

        test('has an explicit CONNECT grant on the current database', async () => {
          const rows = await q(
            `SELECT 1 FROM pg_database d, aclexplode(d.datacl) a
              WHERE d.datname = current_database()
                AND a.grantee = 'nutrition_writer'::regrole
                AND a.privilege_type = 'CONNECT'`,
          );
          assert.equal(rows.length, 1);
        });

        test('INSERT into food_log works with no sequence grant, and is audited', async () => {
          const [{ seq }] = await q(`SELECT pg_get_serial_sequence('public.food_log', 'id') AS seq`);
          assert.ok(seq, 'food_log.id must be an identity column');
          const [{ usage, upd }] = await q(
            `SELECT has_sequence_privilege('nutrition_writer', $1, 'USAGE') AS usage,
                    has_sequence_privilege('nutrition_writer', $1, 'UPDATE') AS upd`,
            [seq],
          );
          assert.equal(usage, false, 'nutrition_writer must not need USAGE on the identity sequence');
          assert.equal(upd, false);

          const { id, day } = await insertItem(writer, { description: 'writer item', created_via: 'claude_mcp' });
          assert.ok(id);
          assert.equal(day, '2026-10-25');
          const audit = await q(
            'SELECT action, changed_by FROM public.food_log_audit WHERE food_log_id = $1 ORDER BY id',
            [id],
          );
          assert.deepEqual(audit, [{ action: 'insert', changed_by: 'nutrition_writer' }]);
        });

        test('DELETE on food_log fails', async () => {
          const { id } = await insertItem(adminQueryable, { description: 'not deletable' });
          await assert.rejects(
            writer.query('DELETE FROM public.food_log WHERE id = $1', [id]),
            (err) => err.code === '42501',
          );
          const [{ n }] = await q('SELECT count(*)::int AS n FROM public.food_log WHERE id = $1', [id]);
          assert.equal(n, 1);
        });

        test('UPDATE food_log SET created_via fails', async () => {
          const { id } = await insertItem(adminQueryable, { description: 'fixed created_via' });
          await assert.rejects(
            writer.query(`UPDATE public.food_log SET created_via = 'import' WHERE id = $1`, [id]),
            (err) => err.code === '42501',
          );
        });

        test('SELECT on workout_samples fails', async () => {
          await assert.rejects(
            writer.query('SELECT 1 FROM public.workout_samples LIMIT 1'),
            (err) => err.code === '42501',
          );
        });
      });

      // ---------------------------------------------------------------------
      // (h) claude_readonly
      // ---------------------------------------------------------------------
      describe('(h) as claude_readonly', () => {
        before(async () => {
          ro = await readonlyPool();
        });

        test('SELECT on food_log and food_log_daily works', async () => {
          const a = await ro.query('SELECT count(*)::int AS n FROM public.food_log');
          assert.equal(typeof a.rows[0].n, 'number');
          const b = await ro.query('SELECT count(*)::int AS n FROM public.food_log_daily');
          assert.equal(typeof b.rows[0].n, 'number');
        });

        test('INSERT into food_log fails', async () => {
          await assert.rejects(
            insertItem(ro, { description: 'readonly attempt' }),
            (err) => ['25006', '42501'].includes(err.code),
          );
        });
      });

      // ---------------------------------------------------------------------
      // (i) food_log_daily
      // ---------------------------------------------------------------------
      describe('(i) food_log_daily', () => {
        test('excludes soft-deleted rows', async () => {
          await insertItem(adminQueryable, { eaten_at: '2030-01-10T08:00-08:00', calories: 300, protein_g: 20 });
          await insertItem(adminQueryable, { eaten_at: '2030-01-10T12:00-08:00', calories: 500, protein_g: 30 });
          const { id: gone } = await insertItem(adminQueryable, {
            eaten_at: '2030-01-10T19:00-08:00',
            calories: 1000,
            protein_g: 50,
          });
          await q('UPDATE public.food_log SET deleted_at = now() WHERE id = $1', [gone]);

          // A day whose only item is soft-deleted has no row at all.
          const { id: lone } = await insertItem(adminQueryable, { eaten_at: '2030-01-11T12:00-08:00' });
          await q('UPDATE public.food_log SET deleted_at = now() WHERE id = $1', [lone]);

          const rows = await q(
            `SELECT day::text AS day, calories, protein_g, items::int AS items
               FROM public.food_log_daily WHERE day IN ('2030-01-10', '2030-01-11') ORDER BY day`,
          );
          assert.equal(rows.length, 1, `got ${JSON.stringify(rows)}`);
          assert.equal(rows[0].day, '2030-01-10');
          assert.equal(Number(rows[0].calories), 800);
          assert.equal(Number(rows[0].protein_g), 50);
          assert.equal(rows[0].items, 2);
        });

        test('sum(fiber_g) is NULL when every item has NULL fiber, and a number otherwise', async () => {
          await insertItem(adminQueryable, { eaten_at: '2030-02-01T08:00-08:00' });
          await insertItem(adminQueryable, { eaten_at: '2030-02-01T12:00-08:00' });
          await insertItem(adminQueryable, { eaten_at: '2030-02-02T08:00-08:00', fiber_g: 4 });
          await insertItem(adminQueryable, { eaten_at: '2030-02-02T12:00-08:00' });
          const rows = await q(
            `SELECT day::text AS day, fiber_g FROM public.food_log_daily
              WHERE day IN ('2030-02-01', '2030-02-02') ORDER BY day`,
          );
          assert.equal(rows.length, 2);
          assert.equal(rows[0].fiber_g, null, 'all-NULL fiber must sum to NULL, not 0');
          assert.equal(Number(rows[1].fiber_g), 4);
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // (j) down script
  // -------------------------------------------------------------------------
  describe('(j) down script', () => {
    before(async () => {
      await closePools();
      await resetDb();
      await upgradeInstall();
    });

    test('raises when food_log has rows and drops nothing', async () => {
      await insertItem(adminQueryable, { description: 'keeps the table alive' });
      await assert.rejects(q(readSql(DOWN)));
      assert.ok(await relExists('public.food_log'));
      assert.ok(await relExists('public.food_log_daily'));
      assert.ok(await roleExists('nutrition_writer'));
      const [{ n }] = await q('SELECT count(*)::int AS n FROM public.food_log');
      assert.equal(n, 1);
    });

    test('drops every object, the role and the ledger row when food_log is empty', async () => {
      await q('DELETE FROM public.food_log');
      // T8 / PLAN.md D2: migration 02's view depends on food_log, so undo 02 first.
      if (fs.existsSync(DOWN_02) && (await ledgerNames()).includes(MIGRATION_02)) {
        await q(readSql(DOWN_02));
      }
      await q(readSql(DOWN));
      for (const rel of [
        'public.food_log_daily',
        'public.food_log_audit',
        'public.food_log',
        'public.my_food_aliases',
        'public.my_foods',
      ]) {
        assert.equal(await relExists(rel), false, `${rel} still exists`);
      }
      const [{ touch, auditfn }] = await q(
        `SELECT to_regprocedure('public.touch_updated_at()')::text AS touch,
                to_regprocedure('public.food_log_audit_fn()')::text AS auditfn`,
      );
      assert.equal(touch, null, 'touch_updated_at() still exists');
      assert.equal(auditfn, null, 'food_log_audit_fn() still exists');
      assert.equal(await roleExists('nutrition_writer'), false, 'role nutrition_writer still exists');
      assert.ok(!(await ledgerNames()).includes(MIGRATION_NAME), 'ledger row not removed');
      // Unrelated tables stay.
      assert.ok(await relExists('public.nutrition_daily'));
      assert.ok(await relExists('public.body_measurements'));
      assert.ok(await relExists('public.schema_migrations'));
    });

    test('the up migration applies again after the down script', async () => {
      await q(readSql(UP));
      assert.ok(await relExists('public.food_log'));
      assert.ok(await roleExists('nutrition_writer'));
      assert.ok((await ledgerNames()).includes(MIGRATION_NAME));
    });
  });

  // -------------------------------------------------------------------------
  // (k) catalog parity (T2)
  // -------------------------------------------------------------------------
  describe('(k) catalog parity', () => {
    test('freshInstall() and upgradeInstall() produce the same catalog, including the new objects', async () => {
      await closePools();
      await resetDb();
      await freshInstall();
      const fresh = JSON.parse(JSON.stringify(await catalogSnapshot()));
      const freshLedger = await ledgerNames();
      await resetDb();
      await upgradeInstall();
      const upgraded = JSON.parse(JSON.stringify(await catalogSnapshot()));
      const upgradedLedger = await ledgerNames();

      for (const [rel, kind] of [
        ['my_foods', 'r'],
        ['my_food_aliases', 'r'],
        ['food_log', 'r'],
        ['food_log_audit', 'r'],
        ['food_log_daily', 'v'],
      ]) {
        const row = fresh.find((r) => r.relname === rel);
        assert.ok(row, `fresh install lacks ${rel}`);
        assert.equal(row.relkind, kind, `${rel} relkind`);
      }
      assert.deepEqual(upgraded, fresh);
      assert.ok(upgradedLedger.includes(MIGRATION_NAME), 'migration 01 must record itself in schema_migrations');
      assert.deepEqual(upgradedLedger, freshLedger);
    });
  });
});
