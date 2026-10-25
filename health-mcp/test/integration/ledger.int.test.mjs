// T3 spec: migration ledger (public.schema_migrations).
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Guard pattern every migration copies (PLAN.md default policy): the first
// statement is a DO block that raises "... already applied" when the
// migration's own name is in public.schema_migrations, and the last statement
// inserts that name. The sample migration in (b) is written to that pattern.

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
const MIGRATIONS_DIR = path.join(REPO, 'health_data_hub/db/migrations');
const LEDGER_UP = path.join(MIGRATIONS_DIR, '2026-11_00_migration_ledger.sql');
const LEDGER_DOWN = path.join(MIGRATIONS_DIR, '2026-11_00_migration_ledger.down.sql');
const SCHEMA_SQL = path.join(REPO, 'health_data_hub/db/schema.sql');

const EXPECTED_ROWS = ['2026-10_body_measurements', '2026-11_00_migration_ledger'];

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
async function relExists(qualified) {
  const [{ oid }] = await q('SELECT to_regclass($1)::text AS oid', [qualified]);
  return oid !== null;
}

// A sample migration written to the documented guard pattern.
const SAMPLE_NAME = '2099-01_t3_sample_guarded';
const SAMPLE_SQL = `
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE name = '${SAMPLE_NAME}') THEN
        RAISE EXCEPTION 'migration ${SAMPLE_NAME} already applied';
    END IF;
END $$;

CREATE TABLE public.t3_sample_probe (a int);

INSERT INTO public.schema_migrations (name) VALUES ('${SAMPLE_NAME}');
`;

describe('migration ledger', () => {
  before(() => {
    assert.ok(URL_, 'TEST_DATABASE_URL must be set for the integration suite');
  });

  after(async () => {
    await closePools();
    if (admin) await admin.end();
  });

  test('files exist and the up migration is picked up by upgradeInstall()', () => {
    readSql(LEDGER_UP);
    readSql(LEDGER_DOWN);
    const names = migrationFiles().map((f) => path.basename(f));
    assert.ok(names.includes('2026-11_00_migration_ledger.sql'));
    assert.ok(!names.includes('2026-11_00_migration_ledger.down.sql'));
    assert.ok(
      names.indexOf('2026-10_body_measurements.sql') < names.indexOf('2026-11_00_migration_ledger.sql'),
      'ledger migration must sort after 2026-10_body_measurements',
    );
  });

  test('the ledger migration opens with a comment documenting the guard pattern', () => {
    const text = readSql(LEDGER_UP).replace(/\r\n/g, '\n');
    const header = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      if (!line.trimStart().startsWith('--')) break;
      header.push(line);
    }
    const comment = header.join('\n');
    assert.ok(header.length > 0, 'file must start with a comment block');
    assert.match(comment, /schema_migrations/, 'guard comment must name schema_migrations');
    assert.match(comment, /already applied/i, 'guard comment must say the guard raises "already applied"');
  });

  test('migrations contain no psql meta-commands', () => {
    for (const f of [LEDGER_UP, LEDGER_DOWN]) {
      const metas = readSql(f)
        .split(/\r?\n/)
        .filter((l) => /^\s*\\/.test(l));
      assert.deepEqual(metas, [], `${path.basename(f)} has psql meta-commands`);
    }
  });

  // -------------------------------------------------------------------------
  // (a) ledger contents and shape
  // -------------------------------------------------------------------------
  describe('(a) ledger after install', () => {
    test('after upgradeInstall() the ledger holds both migrations', async () => {
      await resetDb();
      await upgradeInstall();
      const names = await ledgerNames();
      for (const n of EXPECTED_ROWS) assert.ok(names.includes(n), `ledger missing ${n}: ${JSON.stringify(names)}`);
      const [{ nulls }] = await q(
        'SELECT count(*)::int AS nulls FROM public.schema_migrations WHERE applied_at IS NULL',
      );
      assert.equal(nulls, 0);
    });

    test('after freshInstall() the ledger holds both migrations', async () => {
      await resetDb();
      await freshInstall();
      const names = await ledgerNames();
      for (const n of EXPECTED_ROWS) assert.ok(names.includes(n), `ledger missing ${n}: ${JSON.stringify(names)}`);
    });

    test('schema_migrations is (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())', async () => {
      await resetDb();
      await upgradeInstall();
      const cols = await q(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
                pg_get_expr(d.adbin, d.adrelid) AS dflt
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = 'public.schema_migrations'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
      );
      assert.deepEqual(
        cols.map((c) => [c.name, c.type, c.notnull]),
        [
          ['name', 'text', true],
          ['applied_at', 'timestamp with time zone', true],
        ],
      );
      assert.match(cols[1].dflt || '', /now\(\)|CURRENT_TIMESTAMP/i);
      const pk = await q(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS cols
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.conrelid = 'public.schema_migrations'::regclass AND c.contype = 'p'`,
      );
      assert.deepEqual(pk[0].cols, ['name']);
      // A duplicate name is rejected by the primary key.
      await assert.rejects(
        q(`INSERT INTO public.schema_migrations (name) VALUES ('2026-11_00_migration_ledger')`),
        (err) => err.code === '23505',
      );
    });

    test('claude_readonly can read the ledger but not write it', async () => {
      await resetDb();
      await upgradeInstall();
      const ro = await readonlyPool();
      const { rows } = await ro.query('SELECT name FROM public.schema_migrations');
      assert.ok(rows.length >= EXPECTED_ROWS.length);
      await assert.rejects(
        ro.query(`INSERT INTO public.schema_migrations (name) VALUES ('x')`),
        (err) => ['25006', '42501'].includes(err.code),
      );
    });
  });

  // -------------------------------------------------------------------------
  // (b) guard
  // -------------------------------------------------------------------------
  describe('(b) guarded migrations refuse to re-apply', () => {
    test('a sample guarded migration applies once, then raises "already applied"', async () => {
      await resetDb();
      await upgradeInstall();
      await q(SAMPLE_SQL);
      assert.ok((await ledgerNames()).includes(SAMPLE_NAME));
      assert.ok(await relExists('public.t3_sample_probe'));

      await assert.rejects(q(SAMPLE_SQL), (err) => /already applied/i.test(err.message));
      const [{ n }] = await q('SELECT count(*)::int AS n FROM public.schema_migrations WHERE name = $1', [
        SAMPLE_NAME,
      ]);
      assert.equal(n, 1);
    });

    test('re-applying the ledger migration after upgradeInstall() raises "already applied"', async () => {
      await resetDb();
      await upgradeInstall();
      const before = await ledgerNames();
      await assert.rejects(q(readSql(LEDGER_UP)), (err) => /already applied/i.test(err.message));
      assert.deepEqual(await ledgerNames(), before);
    });

    test('applying the ledger migration after freshInstall() raises "already applied"', async () => {
      await resetDb();
      await freshInstall();
      await assert.rejects(q(readSql(LEDGER_UP)), (err) => /already applied/i.test(err.message));
    });

    test('the ledger migration applies cleanly on the baseline', async () => {
      await resetDb();
      await upgradeInstall();
      await q(readSql(LEDGER_DOWN));
      await q(readSql(LEDGER_UP));
      const names = await ledgerNames();
      for (const n of EXPECTED_ROWS) assert.ok(names.includes(n));
    });
  });

  // -------------------------------------------------------------------------
  // (c) catalog parity
  // -------------------------------------------------------------------------
  describe('(c) catalog parity', () => {
    test('freshInstall() and upgradeInstall() produce the same catalog, including the ledger', async () => {
      await resetDb();
      await freshInstall();
      const fresh = JSON.parse(JSON.stringify(await catalogSnapshot()));
      await resetDb();
      await upgradeInstall();
      const upgraded = JSON.parse(JSON.stringify(await catalogSnapshot()));
      assert.ok(fresh.some((r) => r.relname === 'schema_migrations'), 'fresh install lacks schema_migrations');
      assert.deepEqual(upgraded, fresh);
    });

    test('schema.sql seeds exactly the ledger rows the migrations record', async () => {
      assert.match(readSql(SCHEMA_SQL), /schema_migrations/);
      await resetDb();
      await freshInstall();
      const fresh = await ledgerNames();
      await resetDb();
      await upgradeInstall();
      assert.deepEqual(await ledgerNames(), fresh);
    });
  });

  // -------------------------------------------------------------------------
  // (d) down script
  // -------------------------------------------------------------------------
  describe('(d) down script', () => {
    test('drops schema_migrations and leaves the other tables', async () => {
      await resetDb();
      await upgradeInstall();
      assert.ok(await relExists('public.schema_migrations'));
      await q(readSql(LEDGER_DOWN));
      assert.equal(await relExists('public.schema_migrations'), false);
      assert.ok(await relExists('public.body_measurements'));
      assert.ok(await relExists('public.nutrition_daily'));
    });
  });
});
