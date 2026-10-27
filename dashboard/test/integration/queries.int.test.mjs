// T4 spec (integration): SQL inputs read as dashboard_ro, the /api/dashboard
// JSON built from them, and the read-only startup check.
//
// Needs TEST_DATABASE_URL (a local *_test database; see
// health-mcp/test/integration/harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Interface assumed by these tests:
//   src/queries.mjs  fetchInputs(pool) -> Promise<inputs>, where inputs has the
//                    buildDashboard input fields that demoInputs() also has:
//                    today, weights, nutrition, goals, rideKj, ftp.
//                    rideKj rows are { day, kj } (one row per ride or per day;
//                    buildDashboard sums them per day).
//                    checkReadOnly(pool) -> Promise that resolves when the
//                    pool's session is read-only and rejects otherwise.
//   server.mjs       exits with code 1 when checkReadOnly rejects at startup.
//
// The database is reset only through the guarded harness (resetDb /
// freshInstall / dashboardPool validate TEST_DATABASE_URL first). Fixture rows
// are inserted by a superuser pool opened only after that validation passed
// (LESSONS: roles are cluster-wide; use only guarded helpers).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  resetDb,
  freshInstall,
  dashboardPool,
  closePools,
  DASHBOARD_TEST_PASSWORD,
} from '../../../health-mcp/test/helpers/testdb.mjs';
import { fetchInputs, checkReadOnly } from '../../src/queries.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(HERE, '../..');
const SERVER = path.join(DASHBOARD_DIR, 'server.mjs');

const TOKEN = 'T4specIntegrationTokenBBBBBBBBBBBBBBBB_-2';

// Privacy sentinels: none of these may appear in /api/dashboard output.
const FOOD_ITEM = 'ZQX7 sentinel food item kumquat souffle';
const FOOD_NOTE = 'ZQX7 sentinel food_log note';
const RIDE_TITLE = 'ZQX7 sentinel ride title Col du Secret';
const DPS_NOTE = 'ZQX7 sentinel daily_physical_state note';
const TODAY_CALORIES = 640;

let admin;
function adminPool() {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set for the integration suite');
  if (!admin) admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  return admin;
}
async function q(sql, params) {
  return (await adminPool().query(sql, params)).rows;
}

async function insertWorkout({ sport_type = 'Ride', device_watts = true, kj, start_time, title = null }) {
  const [{ id }] = await q(
    `INSERT INTO public.workouts_raw (source, external_id, start_time, sport_type, kj, device_watts)
     VALUES ('strava', $1, $2, $3, $4, $5) RETURNING id`,
    [`t4-${crypto.randomUUID()}`, start_time, sport_type, kj, device_watts]
  );
  await q(
    `INSERT INTO public.workout_summary (workout_id, sport_type, device_watts, kj, start_time, title)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, sport_type, device_watts, kj, start_time, title]
  );
}

async function seed() {
  // Rides. start_time is naive UTC.
  // 2026-10-21 05:30 UTC = 2026-10-20 22:30 PDT -> LA day 2026-10-20.
  await insertWorkout({ kj: 600, start_time: '2026-10-21 05:30:00', title: RIDE_TITLE });
  // 2026-10-20 18:00 UTC = 2026-10-20 11:00 PDT -> 2026-10-20.
  await insertWorkout({ kj: 150, start_time: '2026-10-20 18:00:00' });
  // 2026-10-21 20:00 UTC = 2026-10-21 13:00 PDT -> 2026-10-21.
  await insertWorkout({ kj: 90, start_time: '2026-10-21 20:00:00' });
  // Excluded: not sport_type 'Ride', no device power, or kj not > 0.
  await insertWorkout({ sport_type: 'Run', kj: 400, start_time: '2026-10-21 05:30:00' });
  await insertWorkout({ sport_type: 'VirtualRide', kj: 250, start_time: '2026-10-21 05:30:00' });
  await insertWorkout({ device_watts: false, kj: 300, start_time: '2026-10-21 05:30:00' });
  await insertWorkout({ kj: 0, start_time: '2026-10-21 05:30:00' });

  // Food logged now (its generated day is the LA date of now()).
  await q(
    `INSERT INTO public.food_log
       (eaten_at, meal, description, calories, protein_g, carbs_g, fat_g, confidence, match_source, created_via, notes)
     VALUES (now(), 'dinner', $1, $2, 50, 60, 20, 'high', 'estimate', 'manual', $3)`,
    [FOOD_ITEM, TODAY_CALORIES, FOOD_NOTE]
  );
  await q(
    `INSERT INTO public.daily_physical_state (day, overall_state, notes)
     VALUES ((now() AT TIME ZONE 'America/Los_Angeles')::date, 'ok', $1)`,
    [DPS_NOTE]
  );
  await q(
    `INSERT INTO public.body_measurements (measured_at, local_day, source, weight_kg)
     VALUES (now(), (now() AT TIME ZONE 'America/Los_Angeles')::date, 'apple_health', 115.20)`
  );
  await q(`INSERT INTO public.ftp_history (effective_from, ftp_watts) VALUES ('2026-09-01', 250)`);
}

async function laToday() {
  const [{ d }] = await q(`SELECT ((now() AT TIME ZONE 'America/Los_Angeles')::date)::text AS d`);
  return d;
}

const pad = (n) => String(n).padStart(2, '0');
// node-pg parses DATE as local midnight; accept that or a 'YYYY-MM-DD' string.
const dayStr = (v) =>
  v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function serverEnv(overrides) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(DB_|DASHBOARD_|PG)/i.test(k) || k === 'TEST_DATABASE_URL') delete env[k];
  }
  const u = new URL(process.env.TEST_DATABASE_URL);
  return {
    ...env,
    HOST: '127.0.0.1',
    DB_HOST: u.hostname,
    DB_PORT: u.port || '5432',
    DB_NAME: decodeURIComponent(u.pathname.replace(/^\//, '')),
    DASHBOARD_TOKENS: TOKEN,
    ...overrides,
  };
}

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { cwd: DASHBOARD_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => output };
}

function within(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);
}

describe('dashboard queries as dashboard_ro (integration)', () => {
  let ro;
  let today;

  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set for the integration suite');
    await closePools();
    await resetDb();
    await freshInstall();
    await seed();
    today = await laToday();
    ro = await dashboardPool();
  });

  after(async () => {
    await closePools();
    if (admin) await admin.end();
  });

  // (f)
  test('(f) ride kJ: naive-UTC start_time lands on its America/Los_Angeles day; only Ride + device_watts + kj>0 count', async () => {
    const inputs = await fetchInputs(ro);
    assert.ok(Array.isArray(inputs.rideKj), 'fetchInputs(pool).rideKj must be an array');
    const byDay = new Map();
    for (const r of inputs.rideKj) {
      const d = dayStr(r.day);
      byDay.set(d, (byDay.get(d) || 0) + Number(r.kj));
    }
    assert.equal(byDay.get('2026-10-20'), 750, `2026-10-20: ${JSON.stringify([...byDay])}`);
    assert.equal(byDay.get('2026-10-21'), 90, `2026-10-21: ${JSON.stringify([...byDay])}`);
    const total = [...byDay.values()].reduce((a, b) => a + b, 0);
    assert.equal(total, 840, `only the three qualifying rides count: ${JSON.stringify([...byDay])}`);
  });

  test('(f) fetchInputs returns today as the LA date and reads every source', async () => {
    const inputs = await fetchInputs(ro);
    assert.equal(dayStr(inputs.today), today);
    for (const k of ['weights', 'nutrition', 'goals', 'rideKj', 'ftp']) {
      assert.ok(Array.isArray(inputs[k]), `inputs.${k} must be an array`);
      assert.ok(inputs[k].length > 0, `inputs.${k} must hold the fixture rows`);
    }
  });

  // (g)
  test('(g) /api/dashboard JSON holds no food item name, meal JSON, ride title or notes', async () => {
    const config = loadConfig({ DASHBOARD_TOKENS: TOKEN, DB_PASSWORD: DASHBOARD_TEST_PASSWORD });
    const logs = [];
    const app = createApp({ config, pool: ro, now: () => new Date(), log: (...a) => logs.push(a.join(' ')) });
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard?range=365`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const text = await res.text();
      assert.equal(res.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.today, today);
      const todayRow = body.nutrition.days.find((d) => d.day === today);
      assert.ok(todayRow, 'today must be in nutrition.days');
      assert.equal(todayRow.calories, TODAY_CALORIES, 'the food_log row must reach the dashboard via nutrition_daily');

      for (const s of [FOOD_ITEM, FOOD_NOTE, RIDE_TITLE, DPS_NOTE, 'ZQX7']) {
        assert.ok(!text.includes(s), `response leaks "${s}"`);
      }
      for (const s of ['meals_json', 'meals', 'dinner', 'kumquat', 'Col du Secret']) {
        assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `response leaks "${s}"`);
      }
      const allLogs = logs.join('\n');
      assert.ok(!allLogs.includes('ZQX7'), 'logs leak fixture strings');
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });

  // (h)
  test('(h) checkReadOnly resolves for dashboard_ro', async () => {
    await checkReadOnly(ro);
  });

  test('(h) checkReadOnly rejects for the admin role (default_transaction_read_only off)', async () => {
    const [{ v }] = await q(`SELECT current_setting('default_transaction_read_only') AS v`);
    assert.equal(v, 'off', 'precondition: the admin session is not read-only');
    await assert.rejects(checkReadOnly(adminPool()));
  });

  describe('(h) server.mjs startup check', () => {
    before(async () => {
      // Free dashboard_ro's connections (CONNECTION LIMIT 3) for the server.
      await closePools();
    });

    test('server.mjs exits 1 when its DB session is not read-only (admin role)', async () => {
      const u = new URL(process.env.TEST_DATABASE_URL);
      const port = await freePort();
      const srv = startServer(
        serverEnv({
          PORT: String(port),
          DB_USER: decodeURIComponent(u.username || 'postgres'),
          DB_PASSWORD: decodeURIComponent(u.password) || 'unused-under-trust-auth',
        })
      );
      const result = await within(srv.exited, 15000);
      if (result === 'timeout') srv.child.kill();
      assert.notEqual(result, 'timeout', `server.mjs kept running as the admin role:\n${srv.output()}`);
      assert.equal(result.code, 1, `exit code ${result.code}, signal ${result.signal}:\n${srv.output()}`);
    });

    test('server.mjs starts and serves /healthz as dashboard_ro', async () => {
      const port = await freePort();
      const srv = startServer(serverEnv({ PORT: String(port), DB_USER: 'dashboard_ro', DB_PASSWORD: DASHBOARD_TEST_PASSWORD }));
      try {
        let ok = false;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !ok) {
          const r = await within(srv.exited, 200);
          if (r !== 'timeout') assert.fail(`server.mjs exited (code ${r.code}) as dashboard_ro:\n${srv.output()}`);
          try {
            const res = await fetch(`http://127.0.0.1:${port}/healthz`);
            ok = res.status === 200;
          } catch {
            // not listening yet
          }
        }
        assert.ok(ok, `server.mjs never served /healthz as dashboard_ro:\n${srv.output()}`);
      } finally {
        srv.child.kill();
        await within(srv.exited, 5000);
      }
    });
  });
});
