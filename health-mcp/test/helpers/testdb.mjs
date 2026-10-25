// Integration-test database harness. Every entry point validates
// TEST_DATABASE_URL (read at call time) before any connection is made.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const DB_DIR = path.join(REPO, 'health_data_hub/db');
const SCHEMA_SQL = path.join(DB_DIR, 'schema.sql');
const BASELINE_SQL = path.join(DB_DIR, 'baseline/schema_2026-10.sql');
const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');

export const READONLY_TEST_PASSWORD = 'claude_readonly_test_pw';

const pools = new Set();

function testUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL must be set');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL');
  }
  // pg-connection-string copies query params (host=, user=, dbname=...) into the
  // driver config, overriding what is checked below. Reject them outright.
  if (u.search || u.hash) {
    throw new Error('TEST_DATABASE_URL must not contain query parameters or a fragment');
  }
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!db.endsWith('_test')) throw new Error('TEST_DATABASE_URL database name must end in _test');
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error('TEST_DATABASE_URL host must be localhost or 127.0.0.1');
  }
  return u;
}

function makePool(u) {
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  pools.add(pool);
  return pool;
}

let adminPoolCache;
function adminPool() {
  const u = testUrl();
  if (!adminPoolCache || adminPoolCache.url !== u.toString()) {
    adminPoolCache = { url: u.toString(), pool: makePool(u) };
  }
  return adminPoolCache.pool;
}

export async function resetDb() {
  const pool = adminPool();
  await pool.query(`
    DROP SCHEMA IF EXISTS monitoring CASCADE;
    DROP SCHEMA IF EXISTS usda CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly') THEN
        CREATE ROLE claude_readonly LOGIN;
      END IF;
    END $$;
    ALTER ROLE claude_readonly WITH LOGIN PASSWORD '${READONLY_TEST_PASSWORD}';
    ALTER ROLE claude_readonly SET default_transaction_read_only = on;
    GRANT USAGE ON SCHEMA public TO claude_readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO claude_readonly;
  `);
}

async function applyFile(file) {
  await adminPool().query(fs.readFileSync(file, 'utf8'));
}

export async function freshInstall() {
  adminPool();
  await applyFile(SCHEMA_SQL);
}

export function migrationFiles(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => path.join(dir, f));
}

export async function upgradeInstall() {
  adminPool();
  await applyFile(BASELINE_SQL);
  for (const f of migrationFiles()) await applyFile(f);
}

export async function catalogSnapshot() {
  const pool = adminPool();
  const { rows } = await pool.query(`
    SELECT c.relname, c.relkind,
      (SELECT coalesce(json_agg(json_build_object(
                'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                'notnull', a.attnotnull) ORDER BY a.attname), '[]'::json)
         FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
      (SELECT coalesce(json_agg(g ORDER BY g), '[]'::json) FROM (
          SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END
                 || ':' || x.privilege_type AS g
            FROM aclexplode(c.relacl) x) s) AS grants
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f','S')
     ORDER BY c.relname`);
  return rows;
}

export async function readonlyPool() {
  const u = testUrl();
  u.username = 'claude_readonly';
  u.password = READONLY_TEST_PASSWORD;
  return makePool(u);
}

export async function closePools() {
  const all = [...pools];
  pools.clear();
  adminPoolCache = undefined;
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}
