// T2 spec: integration test database harness (health-mcp/test/helpers/testdb.mjs).
//
// Needs TEST_DATABASE_URL pointing at a throwaway local Postgres 18 database
// whose name ends in `_test` (locally postgres://postgres@localhost:5433/hdh_test,
// in CI the postgres:18 service). The suite fails, rather than skips, when it
// is unset.
//
// Helper interface assumed by these tests (all read TEST_DATABASE_URL from
// process.env at call time, not at import time):
//   resetDb()            async; drops public/monitoring/usda, recreates public,
//                        ensures role claude_readonly, sets default privileges
//   freshInstall()       async; applies health_data_hub/db/schema.sql
//   upgradeInstall()     async; applies the frozen baseline, then migrations
//   migrationFiles(dir?) the migration files upgradeInstall() applies, in order
//                        (dir defaults to health_data_hub/db/migrations)
//   catalogSnapshot()    async; plain JSON-comparable description of `public`
//   readonlyPool()       pg.Pool (or Promise of one) logged in as claude_readonly
//   closePools()         async; ends every pool the helper opened

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
const SCHEMA_SQL = path.join(REPO, 'health_data_hub/db/schema.sql');
const BASELINE_SQL = path.join(REPO, 'health_data_hub/db/baseline/schema_2026-10.sql');
const MIGRATIONS_DIR = path.join(REPO, 'health_data_hub/db/migrations');
const CI_YML = path.join(REPO, '.github/workflows/kit-ci.yml');

// sha256 of health_data_hub/db/schema.sql at commit c6ca46f (LF line endings).
// The baseline is frozen: it must keep this content even after schema.sql moves on.
const BASELINE_SHA256_LF = '66f4b2cf93fd131fc6acf00e70fdabb13290d9dc84b775d15de9b3d61700f1e3';

const ORIGINAL_URL = process.env.TEST_DATABASE_URL;

function sha256Lf(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

let admin;
function adminPool() {
  if (!admin) {
    assert.ok(ORIGINAL_URL, 'TEST_DATABASE_URL must be set for the integration suite');
    admin = new pg.Pool({ connectionString: ORIGINAL_URL, max: 2 });
  }
  return admin;
}
async function q(sql, params) {
  return (await adminPool().query(sql, params)).rows;
}

// ---------------------------------------------------------------------------
// (a) guard: throws before connecting
// ---------------------------------------------------------------------------
describe('(a) TEST_DATABASE_URL guard', () => {
  const entryPoints = {
    resetDb: () => resetDb(),
    freshInstall: () => freshInstall(),
    upgradeInstall: () => upgradeInstall(),
    catalogSnapshot: () => catalogSnapshot(),
    readonlyPool: () => readonlyPool(),
  };

  // Port 1 on loopback: if the helper did try to connect it would get
  // ECONNREFUSED, never reach a real server, and never leave the machine.
  const badUrls = {
    unset: undefined,
    'empty string': '',
    'database name without _test suffix': 'postgres://postgres@localhost:1/hdh',
    'database name "test" (no underscore)': 'postgres://postgres@127.0.0.1:1/test',
    'database name with _test in the middle': 'postgres://postgres@localhost:1/hdh_test_prod',
    'loopback host other than localhost/127.0.0.1': 'postgres://postgres@127.0.0.2:1/hdh_test',
    'remote host name': 'postgres://postgres@db.example.com:1/hdh_test',
  };

  let connectCalls = 0;
  let realConnect;
  const SENTINEL = 'T2_SPEC_CONNECT_ATTEMPTED';

  before(() => {
    realConnect = pg.Client.prototype.connect;
    pg.Client.prototype.connect = function patchedConnect(cb) {
      connectCalls += 1;
      const err = new Error(SENTINEL);
      if (typeof cb === 'function') {
        process.nextTick(() => cb(err));
        return undefined;
      }
      return Promise.reject(err);
    };
  });

  after(() => {
    pg.Client.prototype.connect = realConnect;
    if (ORIGINAL_URL === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = ORIGINAL_URL;
  });

  for (const [label, url] of Object.entries(badUrls)) {
    for (const [name, call] of Object.entries(entryPoints)) {
      test(`${name}() throws when TEST_DATABASE_URL is ${label}`, async () => {
        if (url === undefined) delete process.env.TEST_DATABASE_URL;
        else process.env.TEST_DATABASE_URL = url;
        const before = connectCalls;
        let caught;
        try {
          const result = await call();
          // A pool returned lazily must not exist at all for a bad URL.
          if (result && typeof result.end === 'function') await result.end().catch(() => {});
        } catch (err) {
          caught = err;
        }
        assert.ok(caught, `${name}() must throw or reject for ${label}`);
        assert.equal(connectCalls, before, `${name}() attempted a connection for ${label}`);
        assert.ok(!String(caught.message).includes(SENTINEL), 'error came from a connection attempt');
        assert.notEqual(caught.code, 'ECONNREFUSED', 'error came from a connection attempt');
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Database-backed tests
// ---------------------------------------------------------------------------
describe('database harness', () => {
  before(() => {
    if (ORIGINAL_URL === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = ORIGINAL_URL;
    assert.ok(ORIGINAL_URL, 'TEST_DATABASE_URL must be set for the integration suite');
  });

  after(async () => {
    await closePools();
    if (admin) await admin.end();
  });

  // -------------------------------------------------------------------------
  // (b) resetDb
  // -------------------------------------------------------------------------
  describe('(b) resetDb()', () => {
    before(async () => {
      // Leave debris behind that resetDb() must clear.
      await q('CREATE SCHEMA IF NOT EXISTS public');
      await q('CREATE TABLE IF NOT EXISTS public.t2_debris (a int)');
      await q('CREATE SCHEMA IF NOT EXISTS monitoring');
      await q('CREATE TABLE IF NOT EXISTS monitoring.t2_debris (a int)');
      await q('CREATE SCHEMA IF NOT EXISTS usda');
      await q('CREATE TABLE IF NOT EXISTS usda.t2_debris (a int)');
      await resetDb();
    });

    test('drops monitoring and usda, recreates an empty public', async () => {
      const schemas = (await q(
        `SELECT nspname FROM pg_namespace WHERE nspname IN ('public','monitoring','usda') ORDER BY 1`,
      )).map((r) => r.nspname);
      assert.deepEqual(schemas, ['public']);
      const rels = await q(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'`,
      );
      assert.deepEqual(rels, []);
    });

    test('is safe to run when the schemas are already absent', async () => {
      await q('DROP SCHEMA IF EXISTS monitoring CASCADE');
      await q('DROP SCHEMA IF EXISTS usda CASCADE');
      await resetDb();
      await resetDb();
      const rows = await q(`SELECT 1 FROM pg_namespace WHERE nspname = 'public'`);
      assert.equal(rows.length, 1);
    });

    test('claude_readonly exists, can log in, has a password and default_transaction_read_only=on', async () => {
      const rows = await q(
        `SELECT r.rolcanlogin, r.rolsuper, r.rolconfig, a.rolpassword IS NOT NULL AS has_password
           FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid
          WHERE r.rolname = 'claude_readonly'`,
      );
      assert.equal(rows.length, 1, 'role claude_readonly must exist');
      assert.equal(rows[0].rolcanlogin, true);
      assert.equal(rows[0].rolsuper, false);
      assert.equal(rows[0].has_password, true, 'claude_readonly needs a known test password');
      assert.ok(
        (rows[0].rolconfig || []).includes('default_transaction_read_only=on'),
        `rolconfig was ${JSON.stringify(rows[0].rolconfig)}`,
      );
    });

    test('default privileges grant SELECT on new public tables to claude_readonly', async () => {
      const acl = await q(
        `SELECT 1
           FROM pg_default_acl d
           JOIN pg_namespace n ON n.oid = d.defaclnamespace,
                aclexplode(d.defaclacl) a
          WHERE n.nspname = 'public'
            AND d.defaclobjtype = 'r'
            AND a.grantee = 'claude_readonly'::regrole
            AND a.privilege_type = 'SELECT'`,
      );
      assert.ok(acl.length >= 1, 'missing ALTER DEFAULT PRIVILEGES IN SCHEMA public ... TO claude_readonly');

      await q('CREATE TABLE public.t2_probe (a int)');
      const [{ sel, ins }] = await q(
        `SELECT has_table_privilege('claude_readonly', 'public.t2_probe', 'SELECT') AS sel,
                has_table_privilege('claude_readonly', 'public.t2_probe', 'INSERT') AS ins`,
      );
      assert.equal(sel, true);
      assert.equal(ins, false);
      await q('DROP TABLE public.t2_probe');
    });
  });

  // -------------------------------------------------------------------------
  // (c) freshInstall / upgradeInstall
  // -------------------------------------------------------------------------
  describe('(c) installs', () => {
    test('the baseline is a frozen copy of schema.sql as of 2026-10', () => {
      assert.ok(fs.existsSync(BASELINE_SQL), `${BASELINE_SQL} must exist`);
      assert.equal(sha256Lf(BASELINE_SQL), BASELINE_SHA256_LF);
    });

    test('migrationFiles() lists every non-down .sql in lexical order', () => {
      const expected = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
        .sort();
      assert.ok(expected.length >= 1);
      const got = migrationFiles().map((f) => path.basename(f));
      assert.deepEqual(got, expected);
    });

    test('migrationFiles(dir) skips *.down.sql and non-sql files and sorts lexically', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdh-t2-migr-'));
      try {
        for (const f of [
          '2026-11_01_b.sql',
          '2026-11_01_b.down.sql',
          '2026-10_a.sql',
          '2026-10_a.down.sql',
          '2026-11_00_c.sql',
          'README.md',
          'notes.sql.bak',
        ]) {
          fs.writeFileSync(path.join(dir, f), '-- fixture\n');
        }
        const got = migrationFiles(dir).map((f) => path.basename(f));
        assert.deepEqual(got, ['2026-10_a.sql', '2026-11_00_c.sql', '2026-11_01_b.sql']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('freshInstall() applies schema.sql', async () => {
      await resetDb();
      await freshInstall();
      const rows = await q(
        `SELECT n.nspname || '.' || c.relname AS rel, c.relkind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE (n.nspname, c.relname) IN (
                ('public','nutrition_daily'), ('public','workout_summary'),
                ('public','body_measurements'), ('public','body_weight_daily'),
                ('monitoring','quality_check_runs'))
          ORDER BY 1`,
      );
      assert.deepEqual(
        rows.map((r) => `${r.rel}:${r.relkind}`),
        [
          'monitoring.quality_check_runs:r',
          'public.body_measurements:r',
          'public.body_weight_daily:v',
          // T8 / PLAN.md D2: nutrition_daily is a view over nutrition_daily_legacy.
          'public.nutrition_daily:v',
          'public.workout_summary:r',
        ],
      );
    });

    test('upgradeInstall() applies the baseline and then the migrations', async () => {
      await resetDb();
      await upgradeInstall();
      const rows = await q(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname IN ('nutrition_daily','body_measurements','body_weight_daily')
          ORDER BY 1`,
      );
      assert.deepEqual(rows.map((r) => r.relname), ['body_measurements', 'body_weight_daily', 'nutrition_daily']);
    });
  });

  // -------------------------------------------------------------------------
  // (d) catalogSnapshot
  // -------------------------------------------------------------------------
  describe('(d) catalogSnapshot()', () => {
    async function snapshotOf(ddl) {
      await resetDb();
      for (const stmt of ddl) await q(stmt);
      return JSON.parse(JSON.stringify(await catalogSnapshot()));
    }
    const BASE = ['CREATE TABLE public.probe (a int)'];

    test('is stable for identical DDL across resets', async () => {
      const a = await snapshotOf(BASE);
      const b = await snapshotOf(BASE);
      assert.deepEqual(a, b);
      assert.ok(JSON.stringify(a).includes('probe'));
    });

    test('sees relation kind', async () => {
      const a = await snapshotOf(BASE);
      const b = await snapshotOf(['CREATE VIEW public.probe AS SELECT 1::int AS a']);
      assert.notDeepEqual(a, b);
    });

    test('sees columns', async () => {
      const a = await snapshotOf(BASE);
      const b = await snapshotOf(['CREATE TABLE public.probe (a int, b int)']);
      assert.notDeepEqual(a, b);
    });

    test('sees types', async () => {
      const a = await snapshotOf(BASE);
      const b = await snapshotOf(['CREATE TABLE public.probe (a bigint)']);
      assert.notDeepEqual(a, b);
    });

    test('sees nullability', async () => {
      const a = await snapshotOf(BASE);
      const b = await snapshotOf(['CREATE TABLE public.probe (a int NOT NULL)']);
      assert.notDeepEqual(a, b);
    });

    test('sees grants', async () => {
      const a = await snapshotOf(BASE);
      const b = await snapshotOf([...BASE, 'GRANT INSERT ON public.probe TO claude_readonly']);
      assert.notDeepEqual(a, b);
    });

    test('is equal after freshInstall() and after upgradeInstall()', async () => {
      await resetDb();
      await freshInstall();
      const fresh = JSON.parse(JSON.stringify(await catalogSnapshot()));
      await resetDb();
      await upgradeInstall();
      const upgraded = JSON.parse(JSON.stringify(await catalogSnapshot()));
      const text = JSON.stringify(fresh);
      assert.ok(text.includes('nutrition_daily') && text.includes('body_measurements'), 'snapshot looks empty');
      assert.deepEqual(upgraded, fresh);
    });
  });

  // -------------------------------------------------------------------------
  // (e) claude_readonly pool
  // -------------------------------------------------------------------------
  describe('(e) readonlyPool()', () => {
    let ro;
    before(async () => {
      await resetDb();
      await freshInstall();
      ro = await readonlyPool();
    });

    test('is logged in as claude_readonly', async () => {
      const { rows } = await ro.query('SELECT current_user AS u');
      assert.equal(rows[0].u, 'claude_readonly');
    });

    test('can SELECT nutrition_daily', async () => {
      const { rows } = await ro.query('SELECT count(*)::int AS n FROM nutrition_daily');
      assert.equal(typeof rows[0].n, 'number');
    });

    test('cannot INSERT into nutrition_daily', async () => {
      await assert.rejects(
        ro.query(`INSERT INTO nutrition_daily (day, calories) VALUES ('2026-01-01', 1)`),
        // 55000: since T8 (PLAN.md D2) nutrition_daily is a non-updatable view.
        (err) => ['25006', '42501', '55000'].includes(err.code),
      );
      const [{ n }] = await q('SELECT count(*)::int AS n FROM nutrition_daily');
      assert.equal(n, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// CI job (static checks on .github/workflows/kit-ci.yml)
// ---------------------------------------------------------------------------
describe('CI node job', () => {
  const yml = fs.existsSync(CI_YML) ? fs.readFileSync(CI_YML, 'utf8').replace(/\r\n/g, '\n') : '';

  test('defines a node job', () => {
    assert.match(yml, /^ {2}node:\s*$/m);
  });

  test('sets up Node 22 with actions/setup-node', () => {
    assert.match(yml, /uses:\s*actions\/setup-node@v\d+/);
    assert.match(yml, /node-version:\s*["']?22(\.x)?["']?\s*$/m);
  });

  test('runs a postgres:18 service with POSTGRES_DB=hdh_test', () => {
    assert.match(yml, /image:\s*["']?postgres:18["']?\s*$/m);
    assert.match(yml, /POSTGRES_DB:\s*["']?hdh_test["']?\s*$/m);
    assert.match(yml, /TEST_DATABASE_URL:\s*\S*(localhost|127\.0\.0\.1)\S*\/hdh_test/);
  });

  test('installs with npm ci in health-mcp, then runs unit and integration suites', () => {
    assert.match(yml, /health-mcp/);
    const ci = yml.search(/npm ci\b/);
    const unit = yml.search(/npm test\b/);
    const integ = yml.search(/npm run test:integration\b/);
    assert.ok(ci >= 0 && unit >= 0 && integ >= 0, 'npm ci, npm test and npm run test:integration must all appear');
    assert.ok(ci < unit && unit < integ, 'order must be npm ci, npm test, npm run test:integration');
  });

  test('keeps the Python job steps', () => {
    assert.match(yml, /actions\/setup-python@v5/);
    assert.match(yml, /run:\s*pip install -r requirements\.txt/);
    assert.match(yml, /run:\s*python -m pytest -q/);
  });
});

test('package.json defines test:integration over test/integration', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'health-mcp/package.json'), 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts['test:integration'], 'missing test:integration script');
  assert.match(pkg.scripts['test:integration'], /test\/integration/);
  assert.doesNotMatch(pkg.scripts.test, /integration/, 'npm test must stay DB-free');
});
