// T14 spec (integration): a ride's day is the America/Los_Angeles date of its
// UTC start time (PLAN.md D8). workout_summary.start_time is a naive UTC
// timestamp, so the day is
//   (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date
// in the nutrition_daily view (migration 02 and schema.sql) and in
// get_day_summary's cycling_kcal.
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// The view tests (a) and (c) run against both freshInstall() and
// upgradeInstall(), because catalogSnapshot() does not see view definitions.
// Fixture rows are inserted directly as the test superuser; the D5 seed goal
// row (2026-10-25, base 2620, factor 1.00) comes from the install.
//
// Tool contract used (from the T9 spec): get_day_summary { day } returns JSON
// in content[0].text with a top-level numeric `cycling_kcal`.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

import {
  resetDb,
  freshInstall,
  upgradeInstall,
  catalogSnapshot,
  closePools,
  READONLY_TEST_PASSWORD,
  WRITER_TEST_PASSWORD,
} from '../helpers/testdb.mjs';
import { loadConfig } from '../../config.mjs';
import { createApp } from '../../app.mjs';
import { createPools } from '../../db.mjs';
import { registerNutritionTools } from '../../tools/nutrition/index.mjs';

const API_KEY = 'k'.repeat(40);
const FROZEN_NOW = new Date('2026-10-25T23:30:00-07:00');

// 2026-10-26T02:00Z is 2026-10-25 19:00 PDT: an evening ride whose UTC date
// is already the next day.
const EVENING_RIDE_UTC = '2026-10-26 02:00:00';
// 2026-10-25T20:00Z is 2026-10-25 13:00 PDT: UTC and LA dates agree.
const MIDDAY_RIDE_UTC = '2026-10-25 20:00:00';

const BASE = 2620;
const RIDE_KJ = 500;

let admin;

function adminPool() {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set for the integration suite');
  if (!admin) admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  return admin;
}

async function q(sql, params) {
  return (await adminPool().query(sql, params)).rows;
}

async function insertFood(eaten_at) {
  await q(
    `INSERT INTO public.food_log
       (eaten_at, meal, description, calories, protein_g, carbs_g, fat_g, confidence, match_source, created_via)
     VALUES ($1, 'lunch', 't14 item', 100, 10, 10, 2, 'high', 'estimate', 'manual')`,
    [eaten_at],
  );
}

async function insertWorkout({ sport_type = 'Ride', device_watts = true, kj, start_time }) {
  const [{ id }] = await q(
    `INSERT INTO public.workouts_raw (source, external_id, start_time, sport_type, kj, device_watts)
     VALUES ('strava', $1, $2, $3, $4, $5) RETURNING id`,
    [`t14-${crypto.randomUUID()}`, start_time, sport_type, kj, device_watts],
  );
  await q(
    `INSERT INTO public.workout_summary (workout_id, sport_type, device_watts, kj, start_time)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, sport_type, device_watts, kj, start_time],
  );
}

async function clearRides() {
  await q('DELETE FROM public.workout_summary');
  await q('DELETE FROM public.workouts_raw');
}

async function goalCalories(day) {
  const rows = await q(`SELECT goal_calories, source FROM public.nutrition_daily WHERE day = $1::date`, [day]);
  assert.equal(rows.length, 1, `expected one nutrition_daily row for ${day}, got ${JSON.stringify(rows)}`);
  assert.equal(rows[0].source, 'food_log');
  return rows[0].goal_calories;
}

// ---------------------------------------------------------------------------
// MCP plumbing (copied from the T9 spec)
// ---------------------------------------------------------------------------
function envFromTestUrl() {
  const raw = process.env.TEST_DATABASE_URL;
  assert.ok(raw, 'TEST_DATABASE_URL must be set for the integration suite');
  const u = new URL(raw);
  return {
    DB_HOST: u.hostname,
    DB_PORT: u.port || '5432',
    DB_NAME: decodeURIComponent(u.pathname.replace(/^\//, '')),
    DB_USER: 'claude_readonly',
    DB_PASSWORD: READONLY_TEST_PASSWORD,
    WRITE_TOOLS_ENABLED: 'true',
    DB_WRITER_USER: 'nutrition_writer',
    DB_WRITER_PASSWORD: WRITER_TEST_PASSWORD,
    MCP_API_KEY: API_KEY,
    OAUTH_STATE_PATH: path.join(os.tmpdir(), `health-mcp-t14-int-${crypto.randomUUID()}.json`),
  };
}

let rpcId = 0;
function mcpCall(port, method, params = {}) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${API_KEY}`,
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseRpc(res) {
  const ct = String(res.headers['content-type'] || '');
  if (ct.includes('text/event-stream')) {
    const messages = res.text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5).trim()));
    assert.ok(messages.length > 0, `no SSE data frames in response: ${res.text}`);
    return messages[messages.length - 1];
  }
  return JSON.parse(res.text);
}

async function listen(app) {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
    s.on('error', reject);
  });
}

function stopApp(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function callOk(port, name, args) {
  const res = await mcpCall(port, 'tools/call', { name, arguments: args });
  assert.equal(res.status, 200, res.text);
  const msg = parseRpc(res);
  assert.ok(msg.result, `expected a result, got ${res.text}`);
  const text = msg.result.content && msg.result.content[0] && msg.result.content[0].text;
  assert.equal(typeof text, 'string', `expected a text content item, got ${res.text}`);
  const body = JSON.parse(text);
  assert.notEqual(msg.result.isError, true, `${name}: expected success, got ${text}`);
  return body;
}

// ---------------------------------------------------------------------------

describe('ride day is the LA date of the UTC start time (D8)', () => {
  after(async () => {
    await admin?.end().catch(() => {});
    admin = undefined;
    await closePools();
  });

  for (const [label, install] of [
    ['freshInstall', freshInstall],
    ['upgradeInstall', upgradeInstall],
  ]) {
    describe(`nutrition_daily view after ${label}()`, () => {
      before(async () => {
        assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set for the integration suite');
        await closePools();
        await resetDb();
        await install();
        // food_log rows so both days appear in the view with source 'food_log'.
        await insertFood('2026-10-25T12:00:00-07:00');
        await insertFood('2026-10-26T12:00:00-07:00');
      });

      test('(a) a ride at 2026-10-26T02:00Z counts toward 2026-10-25, not 2026-10-26', async () => {
        await clearRides();
        await insertWorkout({ kj: RIDE_KJ, start_time: EVENING_RIDE_UTC });
        assert.equal(await goalCalories('2026-10-25'), BASE + RIDE_KJ);
        assert.equal(await goalCalories('2026-10-26'), BASE);
      });

      test('(c) a ride at 2026-10-25T20:00Z (13:00 PT) still counts toward 2026-10-25', async () => {
        await clearRides();
        await insertWorkout({ kj: RIDE_KJ, start_time: MIDDAY_RIDE_UTC });
        assert.equal(await goalCalories('2026-10-25'), BASE + RIDE_KJ);
        assert.equal(await goalCalories('2026-10-26'), BASE);
      });
    });
  }

  describe('get_day_summary cycling_kcal', () => {
    let pools;
    let server;
    let port;

    before(async () => {
      assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set for the integration suite');
      await closePools();
      await resetDb();
      await freshInstall();
      await insertFood('2026-10-25T12:00:00-07:00');
      await insertFood('2026-10-26T12:00:00-07:00');
      const config = loadConfig(envFromTestUrl());
      pools = createPools(config);
      const registerTools = (srv, deps) =>
        registerNutritionTools(srv, { ...deps, now: () => new Date(FROZEN_NOW.getTime()) });
      const app = createApp({ config, pool: pools.read, writePool: pools.write, registerTools });
      ({ server, port } = await listen(app));
    });

    after(async () => {
      await stopApp(server);
      await pools?.read?.end().catch(() => {});
      await pools?.write?.end().catch(() => {});
    });

    test('(b) the 2026-10-26T02:00Z ride gives cycling_kcal 500 on 2026-10-25 and 0 on 2026-10-26', async () => {
      await clearRides();
      await insertWorkout({ kj: RIDE_KJ, start_time: EVENING_RIDE_UTC });
      const d25 = await callOk(port, 'get_day_summary', { day: '2026-10-25' });
      assert.equal(d25.cycling_kcal, RIDE_KJ);
      const d26 = await callOk(port, 'get_day_summary', { day: '2026-10-26' });
      assert.equal(d26.cycling_kcal, 0);
    });

    test('(c) the 2026-10-25T20:00Z ride gives cycling_kcal 500 on 2026-10-25', async () => {
      await clearRides();
      await insertWorkout({ kj: RIDE_KJ, start_time: MIDDAY_RIDE_UTC });
      const d25 = await callOk(port, 'get_day_summary', { day: '2026-10-25' });
      assert.equal(d25.cycling_kcal, RIDE_KJ);
    });
  });

  describe('(e) install parity', () => {
    async function viewDef() {
      const [{ def }] = await q(`SELECT pg_get_viewdef('public.nutrition_daily'::regclass, true) AS def`);
      return def;
    }

    test('freshInstall() and upgradeInstall() give the same catalog and the same nutrition_daily definition', async () => {
      await closePools();
      await resetDb();
      await freshInstall();
      const fresh = JSON.parse(JSON.stringify(await catalogSnapshot()));
      const freshDef = await viewDef();
      await closePools();
      await resetDb();
      await upgradeInstall();
      const upgraded = JSON.parse(JSON.stringify(await catalogSnapshot()));
      const upgradedDef = await viewDef();

      assert.ok(fresh.some((r) => r.relname === 'nutrition_daily' && r.relkind === 'v'), 'nutrition_daily view missing');
      assert.deepEqual(upgraded, fresh);
      assert.equal(upgradedDef, freshDef);
      assert.match(freshDef, /America\/Los_Angeles/);
    });
  });
});
