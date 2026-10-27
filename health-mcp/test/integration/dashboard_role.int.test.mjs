// T1 spec: read-only dashboard_ro Postgres role
// (migration health_data_hub/db/migrations/2026-11_03_dashboard_role.sql,
// same end state appended to health_data_hub/db/schema.sql).
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Helper interface assumed (health-mcp/test/helpers/testdb.mjs):
//   DASHBOARD_TEST_PASSWORD  test-only password constant for dashboard_ro
//   dashboardPool()          pg.Pool (or Promise of one) logged in as
//                            dashboard_ro. It validates TEST_DATABASE_URL
//                            (testUrl()) before it sets the role's test
//                            password, and sets it only through the guarded
//                            admin pool (LESSONS: roles are cluster-wide, so a
//                            database-name guard alone does not protect them).
//
// Behaviour tests (a)-(f) run against both upgradeInstall() and freshInstall().

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
  closePools,
  dashboardPool,
  DASHBOARD_TEST_PASSWORD,
  READONLY_TEST_PASSWORD,
  WRITER_TEST_PASSWORD,
} from '../helpers/testdb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const DB_DIR = path.join(REPO, 'health_data_hub/db');
const SCHEMA_SQL = path.join(DB_DIR, 'schema.sql');
const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');
const MIGRATION_NAME = '2026-11_03_dashboard_role';
const UP = path.join(MIGRATIONS_DIR, `${MIGRATION_NAME}.sql`);
const DOWN = path.join(MIGRATIONS_DIR, `${MIGRATION_NAME}.down.sql`);
const ROLE = 'dashboard_ro';

// The five dashboard sources: the only relations dashboard_ro may read.
const SOURCES = ['body_weight_daily', 'nutrition_daily', 'nutrition_goals', 'ftp_history', 'workout_summary'];

const ALLOWED_SELECTS = [
  'SELECT day, weight_kg FROM public.body_weight_daily',
  `SELECT day, calories, protein_g, carbs_g, fat_g, goal_calories, goal_protein_g, logged_complete
     FROM public.nutrition_daily`,
  `SELECT effective_from, target_weight_kg, base_calories, cycling_kj_factor, protein_g
     FROM public.nutrition_goals`,
  'SELECT effective_from, ftp_watts FROM public.ftp_history',
  'SELECT start_time, sport_type, device_watts, kj FROM public.workout_summary',
];

const DENIED_SELECTS = [
  'SELECT title FROM public.workout_summary',
  'SELECT * FROM public.food_log',
  'SELECT * FROM public.food_log_audit',
  'SELECT * FROM public.daily_physical_state',
  'SELECT * FROM public.oura_sleep_raw',
  'SELECT * FROM public.workouts_raw',
  'SELECT * FROM public.body_measurements',
  'SELECT * FROM public.nutrition_daily_legacy',
];

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
async function roleRow() {
  const rows = await q(
    `SELECT rolcanlogin, rolconnlimit, rolconfig, rolsuper, rolcreaterole, rolcreatedb
       FROM pg_roles WHERE rolname = $1`,
    [ROLE],
  );
  return rows[0] || null;
}
async function rolPassword() {
  const rows = await q('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [ROLE]);
  assert.equal(rows.length, 1, `role ${ROLE} must exist`);
  return rows[0].rolpassword;
}

// Every privilege dashboard_ro holds on any relation or column, in any schema.
async function dashboardGrants() {
  return q(
    `SELECT n.nspname AS schema, c.relname AS rel, NULL::text AS col, x.privilege_type AS priv
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE x.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
     UNION ALL
     SELECT n.nspname, c.relname, a.attname::text, x.privilege_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(a.attacl) x
      WHERE x.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
     ORDER BY 1, 2, 3 NULLS FIRST, 4`,
    [ROLE],
  );
}

async function assertDenied(pool, sql) {
  await assert.rejects(pool.query(sql), (err) => {
    assert.equal(err.code, '42501', `${sql.trim()} -> expected permission denied, got ${err.code}: ${err.message}`);
    return true;
  });
}

// Rows so each source (and each denied table) has data to read.
async function seed() {
  await q(
    `INSERT INTO public.body_measurements (measured_at, local_day, source, weight_kg)
     VALUES ('2026-10-24T07:00:00-07:00', '2026-10-24', 'apple_health', 115.20)`,
  );
  await q(`INSERT INTO public.ftp_history (effective_from, ftp_watts) VALUES ('2026-09-01', 250)`);
  const [{ id }] = await q(
    `INSERT INTO public.workouts_raw (source, external_id, start_time, sport_type, kj, device_watts)
     VALUES ('strava', 't1-spec-ride', '2026-10-24 15:00:00', 'Ride', 600, true) RETURNING id`,
  );
  await q(
    `INSERT INTO public.workout_summary (workout_id, sport_type, device_watts, kj, start_time, title)
     VALUES ($1, 'Ride', true, 600, '2026-10-24 15:00:00', 't1 private ride title')`,
    [id],
  );
  await q(
    `INSERT INTO public.food_log
       (eaten_at, meal, description, calories, protein_g, carbs_g, fat_g, confidence, match_source, created_via)
     VALUES ('2026-10-24T12:00:00-07:00', 'lunch', 't1 item', 500, 40, 50, 15, 'high', 'estimate', 'manual')`,
  );
}

describe('dashboard_ro role (migration 03)', () => {
  before(() => {
    assert.ok(URL_, 'TEST_DATABASE_URL must be set for the integration suite');
  });

  after(async () => {
    await closePools();
    if (admin) await admin.end();
  });

  // -------------------------------------------------------------------------
  // Files and helper
  // -------------------------------------------------------------------------
  describe('migration files and helper', () => {
    test('up and down exist; upgradeInstall() applies 03 after 02 and skips the down file', () => {
      readSql(UP);
      readSql(DOWN);
      const names = migrationFiles().map((f) => path.basename(f));
      assert.ok(names.includes(`${MIGRATION_NAME}.sql`), `migrationFiles() lacks ${MIGRATION_NAME}.sql`);
      assert.ok(!names.includes(`${MIGRATION_NAME}.down.sql`));
      assert.ok(
        names.indexOf('2026-11_02_nutrition_daily_view.sql') < names.indexOf(`${MIGRATION_NAME}.sql`),
        'migration 03 must sort after migration 02',
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

    test('no repo SQL file sets a password: migrations have no PASSWORD, schema.sql none for dashboard_ro', () => {
      for (const f of [UP, DOWN]) {
        assert.doesNotMatch(readSql(f), /PASSWORD/i, `${path.basename(f)} must not set a password`);
      }
      const schema = readSql(SCHEMA_SQL);
      assert.match(schema, /dashboard_ro/, 'schema.sql must create dashboard_ro');
      const statements = schema.split(';').filter((s) => /dashboard_ro/.test(s));
      for (const s of statements) {
        assert.doesNotMatch(s, /PASSWORD/i, `schema.sql sets a password for dashboard_ro: ${s.trim()}`);
      }
    });

    test('DASHBOARD_TEST_PASSWORD is a distinct, test-only string constant', () => {
      assert.equal(typeof DASHBOARD_TEST_PASSWORD, 'string');
      assert.ok(DASHBOARD_TEST_PASSWORD.length > 0);
      assert.match(DASHBOARD_TEST_PASSWORD, /test/i);
      assert.notEqual(DASHBOARD_TEST_PASSWORD, READONLY_TEST_PASSWORD);
      assert.notEqual(DASHBOARD_TEST_PASSWORD, WRITER_TEST_PASSWORD);
      assert.equal(typeof dashboardPool, 'function');
    });
  });

  // -------------------------------------------------------------------------
  // (a)-(f) on both install paths
  // -------------------------------------------------------------------------
  const INSTALLS = { upgradeInstall: () => upgradeInstall(), freshInstall: () => freshInstall() };
  const grantsByInstall = {};

  for (const [installName, install] of Object.entries(INSTALLS)) {
    describe(`after ${installName}()`, () => {
      let roPool;
      async function ro() {
        if (!roPool) roPool = await dashboardPool();
        return roPool;
      }
      async function dropPools() {
        roPool = undefined;
        await closePools();
      }

      before(async () => {
        await dropPools();
        await resetDb();
        await install();
        await seed();
      });

      after(async () => {
        await dropPools();
      });

      // ---------------------------------------------------------------------
      // (a) role attributes
      // ---------------------------------------------------------------------
      test('(a) role exists with LOGIN, CONNECTION LIMIT 3, read-only and 5 s statement timeout', async () => {
        const r = await roleRow();
        assert.ok(r, `role ${ROLE} must exist`);
        assert.equal(r.rolcanlogin, true, 'LOGIN');
        assert.equal(r.rolconnlimit, 3, 'CONNECTION LIMIT 3');
        assert.equal(r.rolsuper, false);
        assert.equal(r.rolcreaterole, false);
        assert.equal(r.rolcreatedb, false);
        const cfg = r.rolconfig || [];
        assert.ok(
          cfg.some((c) => /^default_transaction_read_only=(on|true)$/i.test(c)),
          `rolconfig lacks default_transaction_read_only=on: ${JSON.stringify(cfg)}`,
        );
        assert.ok(
          cfg.some((c) => /^statement_timeout=(5000|5000ms|5s)$/.test(c)),
          `rolconfig lacks statement_timeout=5000: ${JSON.stringify(cfg)}`,
        );
      });

      test('(a) dashboardPool() logs in as dashboard_ro in read-only transactions with statement_timeout 5000 ms', async () => {
        const pool = await ro();
        const { rows } = await pool.query(
          `SELECT current_user AS u,
                  current_setting('default_transaction_read_only') AS dro,
                  current_setting('transaction_read_only') AS tro,
                  (SELECT setting FROM pg_settings WHERE name = 'statement_timeout') AS st`,
        );
        assert.deepEqual(rows[0], { u: ROLE, dro: 'on', tro: 'on', st: '5000' });
      });

      // ---------------------------------------------------------------------
      // (b) the five sources are readable
      // ---------------------------------------------------------------------
      for (const sql of ALLOWED_SELECTS) {
        test(`(b) as dashboard_ro: ${sql.replace(/\s+/g, ' ')}`, async () => {
          const pool = await ro();
          const res = await pool.query(sql);
          assert.ok(res.rows.length >= 1, `expected at least one seeded row from: ${sql}`);
        });
      }

      // ---------------------------------------------------------------------
      // (c) everything else is denied
      // ---------------------------------------------------------------------
      for (const sql of DENIED_SELECTS) {
        test(`(c) as dashboard_ro, permission denied: ${sql}`, async () => {
          await assertDenied(await ro(), sql);
        });
      }

      test('(c) dashboard_ro holds SELECT only, only on the five sources; workout_summary only per column, never title', async () => {
        const grants = await dashboardGrants();
        grantsByInstall[installName] = JSON.parse(JSON.stringify(grants));
        assert.ok(grants.length > 0, 'dashboard_ro has no grants');
        for (const g of grants) {
          assert.equal(g.priv, 'SELECT', `unexpected privilege ${JSON.stringify(g)}`);
          assert.equal(g.schema, 'public', `grant outside public: ${JSON.stringify(g)}`);
          assert.ok(SOURCES.includes(g.rel), `grant on a non-dashboard relation: ${JSON.stringify(g)}`);
        }
        const ws = grants.filter((g) => g.rel === 'workout_summary');
        assert.ok(!ws.some((g) => g.col === null), 'workout_summary must not have a table-level grant');
        assert.ok(!ws.some((g) => g.col === 'title'), 'workout_summary.title must not be granted');
      });

      // ---------------------------------------------------------------------
      // (d) writes fail
      // ---------------------------------------------------------------------
      test('(d) INSERT into nutrition_goals fails and writes nothing', async () => {
        const pool = await ro();
        await assert.rejects(
          pool.query(`INSERT INTO public.nutrition_goals (effective_from, base_calories) VALUES ('2030-01-01', 2000)`),
          (err) => ['25006', '42501'].includes(err.code),
        );
        const [{ n }] = await q(`SELECT count(*)::int AS n FROM public.nutrition_goals WHERE effective_from = '2030-01-01'`);
        assert.equal(n, 0);
      });

      // ---------------------------------------------------------------------
      // (f) no default privileges
      // ---------------------------------------------------------------------
      test('(f) a table created after the migration is not readable by dashboard_ro', async () => {
        await q('CREATE TABLE public.t1_created_after_migration (a int)');
        await q('INSERT INTO public.t1_created_after_migration VALUES (1)');
        await assertDenied(await ro(), 'SELECT a FROM public.t1_created_after_migration');
        const [{ n }] = await q(
          `SELECT count(*)::int AS n FROM pg_default_acl d, aclexplode(d.defaclacl) x
            WHERE x.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
          [ROLE],
        );
        assert.equal(n, 0, 'dashboard_ro must have no default privileges');
      });

      // ---------------------------------------------------------------------
      // (e) ledger, guard, down/up round trip
      // ---------------------------------------------------------------------
      test('(e) the ledger records migration 03 and re-applying it raises "already applied"', async () => {
        assert.ok((await ledgerNames()).includes(MIGRATION_NAME), `ledger lacks ${MIGRATION_NAME}`);
        await assert.rejects(q(readSql(UP)), (err) => /already applied/i.test(err.message));
      });

      test('(e) down removes the role and the ledger row; up restores the same role and grants', async () => {
        const grantsBefore = JSON.parse(JSON.stringify(await dashboardGrants()));
        const roleBefore = await roleRow();
        await dropPools();

        await q(readSql(DOWN));
        assert.equal(await roleRow(), null, 'role dashboard_ro still exists after the down script');
        assert.ok(!(await ledgerNames()).includes(MIGRATION_NAME), 'ledger row not removed');
        for (const rel of SOURCES) {
          const [{ oid }] = await q('SELECT to_regclass($1)::text AS oid', [`public.${rel}`]);
          assert.ok(oid !== null, `down script must not drop ${rel}`);
        }

        await q(readSql(UP));
        assert.ok((await ledgerNames()).includes(MIGRATION_NAME));
        const roleAfter = await roleRow();
        assert.ok(roleAfter, 'role not recreated by the up migration');
        assert.deepEqual(
          { ...roleAfter, rolconfig: [...(roleAfter.rolconfig || [])].sort() },
          { ...roleBefore, rolconfig: [...(roleBefore.rolconfig || [])].sort() },
        );
        assert.deepEqual(JSON.parse(JSON.stringify(await dashboardGrants())), grantsBefore);

        const pool = await ro();
        for (const sql of ALLOWED_SELECTS) await pool.query(sql);
        await assertDenied(pool, 'SELECT title FROM public.workout_summary');
        await assert.rejects(q(readSql(UP)), (err) => /already applied/i.test(err.message));
      });
    });
  }

  describe('install parity', () => {
    test('freshInstall() and upgradeInstall() give dashboard_ro the same grants', () => {
      assert.ok(grantsByInstall.upgradeInstall, 'upgradeInstall() grants not captured');
      assert.ok(grantsByInstall.freshInstall, 'freshInstall() grants not captured');
      assert.deepEqual(grantsByInstall.freshInstall, grantsByInstall.upgradeInstall);
    });
  });

  // -------------------------------------------------------------------------
  // dashboardPool() guard: validation before the password is set
  // -------------------------------------------------------------------------
  describe('dashboardPool() validates TEST_DATABASE_URL before setting the password', () => {
    before(async () => {
      await closePools();
      await resetDb();
      await freshInstall();
    });

    after(async () => {
      process.env.TEST_DATABASE_URL = URL_;
      await closePools();
    });

    // Both URLs reach a real, non-test database on the same cluster, so an
    // unguarded ALTER ROLE would succeed and change the cluster-wide password.
    const bad = () => {
      const nonTest = new URL(URL_);
      nonTest.pathname = '/postgres';
      return [
        { label: 'database not ending in _test', url: nonTest.toString(), msg: /_test/ },
        { label: 'query parameters', url: `${new URL(URL_).toString()}?dbname=postgres`, msg: /query parameters/ },
      ];
    };

    for (const i of [0, 1]) {
      test(`rejects and leaves dashboard_ro's password untouched (case ${i + 1})`, async () => {
        const c = bad()[i];
        const pwBefore = await rolPassword();
        process.env.TEST_DATABASE_URL = c.url;
        try {
          await assert.rejects(async () => dashboardPool(), c.msg, c.label);
        } finally {
          process.env.TEST_DATABASE_URL = URL_;
          await closePools();
        }
        assert.equal(await rolPassword(), pwBefore, `${c.label}: password changed despite a rejected URL`);
      });
    }

    test('with a valid URL it sets the test password and connects as dashboard_ro', async () => {
      const pool = await dashboardPool();
      const { rows } = await pool.query('SELECT current_user AS u');
      assert.equal(rows[0].u, ROLE);
      assert.ok(await rolPassword(), 'dashboard_ro has no password after dashboardPool()');
      await closePools();
    });
  });
});
