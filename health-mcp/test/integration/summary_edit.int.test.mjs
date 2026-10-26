// T9 spec (integration): get_day_summary (build-plan §5.7 + PLAN.md D5),
// update_log_entry (§5.5), delete_log_entry with restore (§5.6) and
// mark_day_complete (§5.8).
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Module interface assumed (exported names):
//   tools/nutrition/index.mjs
//     registerNutritionTools(server, { pool, writePool, config, guard, now })
//       Registers get_day_summary (reads via `pool`, claude_readonly),
//       update_log_entry, delete_log_entry and mark_day_complete (write via
//       `writePool`, nutrition_writer, each through `guard.check`) alongside the
//       T6/T7 tools when config.WRITES_ENABLED is true.
//   (new files tools/nutrition/summary.mjs and tools/nutrition/edit.mjs are
//    reached only through registerNutritionTools; no direct imports here.)
//
// Clock injection: `now` is an optional `() => Date` (default `() => new Date()`)
// passed in the registerNutritionTools deps. get_day_summary and
// mark_day_complete use it for "today in America/Los_Angeles" when `day` is
// omitted, and update_log_entry uses it for any time-window check. createApp
// calls registerTools(server, { pool, writePool, config, guard }), so this
// suite wraps it to add `now` (see FROZEN_NOW below).
//
// Tool contract assumed (all responses are JSON in content[0].text):
//   get_day_summary { day?, include_items? } ->
//     { day: 'YYYY-MM-DD', source: 'food_log'|'legacy'|'none', totals, goals, remaining,
//       items: [ { id, eaten_at_local, meal, description, ..., confidence, match_source } ],
//       cycling_kcal: number, kg_to_target: number|null, note?: string, logged_complete, ... }
//     items ordered by eaten_at; soft-deleted rows absent. cycling_kcal and
//     kg_to_target are top-level keys (D5). A legacy day carries `note`.
//   update_log_entry { id, patch } -> { before: row, after: row, day_totals: { 'YYYY-MM-DD': totals } }
//   delete_log_entry { ids, restore? } -> { affected: [ids], unchanged: [ids], day_totals }
//   mark_day_complete { day?, complete, note? } -> output shape not pinned.
//   row / totals: nutrient values are JS numbers.
//   errors: isError: true, text {"error":{"code","message","item_index"?,"field"?}}.
//
// Fixture rows are inserted directly as the test superuser, so no test depends
// on the real clock.

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
  closePools,
  READONLY_TEST_PASSWORD,
  WRITER_TEST_PASSWORD,
} from '../helpers/testdb.mjs';
import { loadConfig } from '../../config.mjs';
import { createApp } from '../../app.mjs';
import { createPools } from '../../db.mjs';
import { registerNutritionTools } from '../../tools/nutrition/index.mjs';

const API_KEY = 'k'.repeat(40);

// 23:30 in Los Angeles on 2026-10-25 is already 2026-10-26 in UTC.
const FROZEN_NOW = new Date('2026-10-25T23:30:00-07:00');
const TODAY = '2026-10-25';

function envFromTestUrl(overrides = {}) {
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
    OAUTH_STATE_PATH: path.join(os.tmpdir(), `health-mcp-t9-int-${crypto.randomUUID()}.json`),
    ...overrides,
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
      }
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
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  return { server, port: server.address().port };
}

function stopApp(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function listTools(port) {
  const res = await mcpCall(port, 'tools/list');
  assert.equal(res.status, 200, res.text);
  const msg = parseRpc(res);
  assert.ok(msg.result && Array.isArray(msg.result.tools), `expected tools, got ${res.text}`);
  return msg.result.tools;
}

// Calls a tool; returns { result, body } where body is the parsed JSON text.
async function callTool(port, name, args) {
  const res = await mcpCall(port, 'tools/call', { name, arguments: args });
  assert.equal(res.status, 200, res.text);
  const msg = parseRpc(res);
  assert.ok(msg.result, `expected a result, got ${res.text}`);
  const text = msg.result.content && msg.result.content[0] && msg.result.content[0].text;
  assert.equal(typeof text, 'string', `expected a text content item, got ${res.text}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    assert.fail(`${name}: tool output is not JSON: ${text}`);
  }
  return { result: msg.result, body };
}

async function callOk(port, name, args) {
  const { result, body } = await callTool(port, name, args);
  assert.notEqual(result.isError, true, `${name}: expected success, got ${JSON.stringify(body)}`);
  return body;
}

async function callErr(port, name, args) {
  const { result, body } = await callTool(port, name, args);
  assert.equal(result.isError, true, `${name}: expected an error, got ${JSON.stringify(body)}`);
  assert.ok(body.error, `expected {"error":{...}}, got ${JSON.stringify(body)}`);
  assert.equal(typeof body.error.code, 'string');
  assert.equal(typeof body.error.message, 'string');
  return body.error;
}

describe('get_day_summary, update_log_entry, delete_log_entry, mark_day_complete', () => {
  let admin;
  let pools;
  let server;
  let port;

  async function q(sql, params) {
    return (await admin.query(sql, params)).rows;
  }

  // One food_log row, inserted as the superuser; override any column.
  async function insertFood(overrides = {}) {
    const row = {
      eaten_at: '2026-10-24T12:00:00-07:00',
      meal: 'lunch',
      description: 't9 item',
      calories: 100,
      protein_g: 10,
      carbs_g: 10,
      fat_g: 2,
      confidence: 'med',
      match_source: 'estimate',
      created_via: 'claude_mcp',
      ...overrides,
    };
    const cols = Object.keys(row);
    const rows = await q(
      `INSERT INTO public.food_log (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING id, day::text AS day`,
      cols.map((c) => row[c])
    );
    return { id: Number(rows[0].id), day: rows[0].day };
  }

  async function foodRow(id) {
    const rows = await q(
      `SELECT id, day::text AS day, calories::float8 AS calories, protein_g::float8 AS protein_g,
              carbs_g::float8 AS carbs_g, fat_g::float8 AS fat_g, fiber_g::float8 AS fiber_g,
              sugar_g::float8 AS sugar_g, sodium_mg::float8 AS sodium_mg, deleted_at
         FROM public.food_log WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  async function insertWorkout({ sport_type, device_watts, kj, start_time }) {
    const [{ id }] = await q(
      `INSERT INTO public.workouts_raw (source, external_id, start_time, sport_type, kj, device_watts)
       VALUES ('strava', $1, $2, $3, $4, $5) RETURNING id`,
      [`t9-${crypto.randomUUID()}`, start_time, sport_type, kj, device_watts]
    );
    await q(
      `INSERT INTO public.workout_summary (workout_id, sport_type, device_watts, kj, start_time)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, sport_type, device_watts, kj, start_time]
    );
  }

  async function insertWeight(day, weight_kg) {
    await q(
      `INSERT INTO public.body_measurements (measured_at, local_day, source, weight_kg)
       VALUES (($1::date + time '07:00') AT TIME ZONE 'America/Los_Angeles', $1::date, 'apple_health', $2)`,
      [day, weight_kg]
    );
  }

  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set for the integration suite');
    await resetDb();
    await freshInstall();
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    const config = loadConfig(envFromTestUrl());
    pools = createPools(config);
    assert.ok(pools.write, 'expected a write pool with WRITE_TOOLS_ENABLED=true');
    const registerTools = (srv, deps) => registerNutritionTools(srv, { ...deps, now: () => new Date(FROZEN_NOW.getTime()) });
    const app = createApp({ config, pool: pools.read, writePool: pools.write, registerTools });
    ({ server, port } = await listen(app));
  });

  after(async () => {
    await stopApp(server);
    await pools?.read?.end().catch(() => {});
    await pools?.write?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await closePools();
  });

  // ---------------------------------------------------------------------------
  // get_day_summary
  // ---------------------------------------------------------------------------
  describe('get_day_summary', () => {
    const ids = {};

    before(async () => {
      // Inserted out of eaten_at order so id order differs from eaten_at order.
      ids.lunch = (await insertFood({ eaten_at: '2026-10-25T12:30:00-07:00', meal: 'lunch', description: 'Chicken salad', calories: 550, protein_g: 45, carbs_g: 20, fat_g: 30 })).id;
      ids.dinner = (await insertFood({ eaten_at: '2026-10-25T19:00:00-07:00', meal: 'dinner', description: 'Pasta', calories: 800, protein_g: 30, carbs_g: 110, fat_g: 22 })).id;
      ids.breakfast = (await insertFood({ eaten_at: '2026-10-25T08:00:00-07:00', meal: 'breakfast', description: 'Oatmeal', calories: 410, protein_g: 22, carbs_g: 58, fat_g: 10 })).id;
      ids.deleted = (await insertFood({ eaten_at: '2026-10-25T15:00:00-07:00', meal: 'snack', description: 'Deleted cookie', calories: 250, protein_g: 3, carbs_g: 35, fat_g: 12 })).id;
      await q('UPDATE public.food_log SET deleted_at = now() WHERE id = $1', [ids.deleted]);
      // An item on the UTC date of FROZEN_NOW, to catch a UTC default day.
      await insertFood({ eaten_at: '2026-10-26T12:00:00-07:00', meal: 'lunch', description: 'Tomorrow item', calories: 999, protein_g: 1, carbs_g: 1, fat_g: 1 });
      await insertFood({ eaten_at: '2026-10-24T12:00:00-07:00', meal: 'lunch', description: 'Yesterday item', calories: 600, protein_g: 40, carbs_g: 60, fat_g: 20 });

      // D5: powered Rides on TODAY count; others do not.
      await insertWorkout({ sport_type: 'Ride', device_watts: true, kj: 812.4, start_time: '2026-10-25 07:00:00' });
      await insertWorkout({ sport_type: 'Ride', device_watts: true, kj: 300, start_time: '2026-10-25 17:30:00' });
      await insertWorkout({ sport_type: 'EBikeRide', device_watts: false, kj: 500, start_time: '2026-10-25 12:00:00' });
      await insertWorkout({ sport_type: 'Ride', device_watts: false, kj: 200, start_time: '2026-10-25 13:00:00' });
      await insertWorkout({ sport_type: 'Run', device_watts: true, kj: 400, start_time: '2026-10-25 06:00:00' });
      await insertWorkout({ sport_type: 'Ride', device_watts: true, kj: 999, start_time: '2026-10-24 07:00:00' });

      // body_weight_daily: latest weight is 105.80 kg on 2026-10-24.
      await insertWeight('2026-10-18', 106.9);
      await insertWeight('2026-10-20', 106.4);
      await insertWeight('2026-10-24', 105.8);

      // A legacy-only day.
      await q(
        `INSERT INTO public.nutrition_daily_legacy
           (day, calories, protein_g, carbs_g, fat_g, goal_calories, source, logged_complete)
         VALUES ('2026-09-01', 2100, 150, 200, 70, 2300, 'apple_health', true)`
      );
    });

    test('(a) with the clock frozen at 2026-10-25T23:30-07:00 the default day is 2026-10-25', async () => {
      const body = await callOk(port, 'get_day_summary', {});
      assert.equal(body.day, TODAY);
      assert.equal(body.source, 'food_log');
    });

    test('(b) items are ordered by eaten_at, carry their ids, and soft-deleted items are absent', async () => {
      const body = await callOk(port, 'get_day_summary', { day: TODAY });
      assert.ok(Array.isArray(body.items), `expected items array, got ${JSON.stringify(body)}`);
      assert.deepEqual(
        body.items.map((i) => Number(i.id)),
        [ids.breakfast, ids.lunch, ids.dinner]
      );
      assert.deepEqual(
        body.items.map((i) => i.description),
        ['Oatmeal', 'Chicken salad', 'Pasta']
      );
      assert.ok(!body.items.some((i) => Number(i.id) === ids.deleted), 'a soft-deleted item must not be listed');
    });

    test('(c) a legacy-only day returns source "legacy" and a note', async () => {
      const body = await callOk(port, 'get_day_summary', { day: '2026-09-01' });
      assert.equal(body.day, '2026-09-01');
      assert.equal(body.source, 'legacy');
      assert.equal(typeof body.note, 'string');
      assert.ok(body.note.length > 0, 'note must not be empty');
      assert.equal((body.items ?? []).length, 0, 'a legacy day has no item detail');
    });

    test('(d) kg_to_target = latest weight - 100 and cycling_kcal = the D5 sum for the day', async () => {
      const body = await callOk(port, 'get_day_summary', { day: TODAY });
      assert.equal(typeof body.kg_to_target, 'number', `kg_to_target missing: ${JSON.stringify(body)}`);
      assert.ok(Math.abs(body.kg_to_target - 5.8) < 1e-6, `kg_to_target was ${body.kg_to_target}, expected 5.8`);
      // round(1.00 * (812.4 + 300)) = 1112
      assert.equal(body.cycling_kcal, 1112);

      const rest = await callOk(port, 'get_day_summary', { day: '2026-10-24' });
      // One powered 999 kJ Ride on 2026-10-24.
      assert.equal(rest.source, 'food_log');
      assert.equal(rest.cycling_kcal, 999);
    });
  });

  // ---------------------------------------------------------------------------
  // update_log_entry
  // ---------------------------------------------------------------------------
  describe('update_log_entry', () => {
    test('(e) servings 1 -> 2 on a favorite entry with no nutrients doubles them; one update audit row', async () => {
      const [{ id: favId }] = await q(
        `INSERT INTO public.my_foods (name, serving_qty, serving_unit, serving_grams, calories, protein_g, carbs_g, fat_g,
                                      fiber_g, sugar_g, sodium_mg, confidence, basis)
         VALUES ('Usual oatmeal', 1, 'bowl', 320, 410, 22, 58, 10, 8, 14, 180, 'high', 'recipe') RETURNING id`
      );
      const { id } = await insertFood({
        eaten_at: '2026-10-23T08:00:00-07:00',
        meal: 'breakfast',
        description: 'Usual oatmeal',
        quantity: 1,
        unit: 'bowl',
        grams: 320,
        calories: 410,
        protein_g: 22,
        carbs_g: 58,
        fat_g: 10,
        fiber_g: 8,
        sugar_g: 14,
        sodium_mg: 180,
        confidence: 'high',
        match_source: 'favorite',
        my_food_id: Number(favId),
      });

      const body = await callOk(port, 'update_log_entry', { id, patch: { servings: 2 } });
      assert.ok(body.before && body.after, `expected {before, after}, got ${JSON.stringify(body)}`);
      assert.equal(body.before.calories, 410);
      assert.equal(body.after.calories, 820);
      assert.equal(body.after.protein_g, 44);
      assert.equal(body.after.carbs_g, 116);
      assert.equal(body.after.fat_g, 20);

      const row = await foodRow(id);
      assert.equal(row.calories, 820);
      assert.equal(row.protein_g, 44);
      assert.equal(row.carbs_g, 116);
      assert.equal(row.fat_g, 20);
      assert.equal(row.fiber_g, 16);
      assert.equal(row.sugar_g, 28);
      assert.equal(row.sodium_mg, 360);

      const [{ n }] = await q(
        `SELECT count(*)::int AS n FROM public.food_log_audit WHERE food_log_id = $1 AND action = 'update'`,
        [id]
      );
      assert.equal(n, 1);
    });

    test("(f) moving an entry's day returns day_totals for both days", async () => {
      const moved = await insertFood({ eaten_at: '2026-10-22T12:30:00-07:00', meal: 'lunch', description: 'Burrito', calories: 500, protein_g: 25, carbs_g: 60, fat_g: 18 });
      await insertFood({ eaten_at: '2026-10-22T19:00:00-07:00', meal: 'dinner', description: 'Soup', calories: 300, protein_g: 15, carbs_g: 30, fat_g: 10 });
      await insertFood({ eaten_at: '2026-10-21T19:00:00-07:00', meal: 'dinner', description: 'Rice bowl', calories: 200, protein_g: 8, carbs_g: 35, fat_g: 3 });
      assert.equal(moved.day, '2026-10-22');

      const body = await callOk(port, 'update_log_entry', { id: moved.id, patch: { day: '2026-10-21' } });
      assert.equal(body.after.day, '2026-10-21');
      assert.ok(body.day_totals, `expected day_totals, got ${JSON.stringify(body)}`);
      assert.ok(body.day_totals['2026-10-22'], `day_totals lacks the old day: ${JSON.stringify(body.day_totals)}`);
      assert.ok(body.day_totals['2026-10-21'], `day_totals lacks the new day: ${JSON.stringify(body.day_totals)}`);
      assert.equal(body.day_totals['2026-10-22'].calories, 300);
      assert.equal(body.day_totals['2026-10-21'].calories, 700);

      const row = await foodRow(moved.id);
      assert.equal(row.day, '2026-10-21');
    });

    test('(g) updating a deleted entry gives ALREADY_DELETED and changes nothing', async () => {
      const { id } = await insertFood({ eaten_at: '2026-10-24T15:00:00-07:00', meal: 'snack', description: 'Gone bar', calories: 220 });
      await q('UPDATE public.food_log SET deleted_at = now() WHERE id = $1', [id]);
      const err = await callErr(port, 'update_log_entry', { id, patch: { calories: 100 } });
      assert.equal(err.code, 'ALREADY_DELETED');
      const row = await foodRow(id);
      assert.equal(row.calories, 220);
      assert.notEqual(row.deleted_at, null);
    });
  });

  // ---------------------------------------------------------------------------
  // delete_log_entry
  // ---------------------------------------------------------------------------
  describe('delete_log_entry', () => {
    test('(h) a missing id gives NOT_FOUND and changes nothing; twice is unchanged; restore brings it back', async () => {
      const { id } = await insertFood({ eaten_at: '2026-10-20T12:00:00-07:00', meal: 'lunch', description: 'Sandwich', calories: 450 });

      const err = await callErr(port, 'delete_log_entry', { ids: [id, 999999] });
      assert.equal(err.code, 'NOT_FOUND');
      assert.match(err.message, /999999/, 'NOT_FOUND must list the missing ids');
      assert.equal((await foodRow(id)).deleted_at, null, 'nothing may change when an id is missing');

      const first = await callOk(port, 'delete_log_entry', { ids: [id] });
      assert.deepEqual(first.affected.map(Number), [id]);
      assert.deepEqual(first.unchanged.map(Number), []);
      const deleted = await foodRow(id);
      assert.ok(deleted, 'delete is soft: the row must still exist');
      assert.notEqual(deleted.deleted_at, null);
      const gone = await q(`SELECT 1 FROM public.food_log_daily WHERE day = '2026-10-20'`);
      assert.equal(gone.length, 0, 'a deleted row is gone from food_log_daily');

      const second = await callOk(port, 'delete_log_entry', { ids: [id] });
      assert.deepEqual(second.affected.map(Number), []);
      assert.deepEqual(second.unchanged.map(Number), [id]);

      const restored = await callOk(port, 'delete_log_entry', { ids: [id], restore: true });
      assert.deepEqual(restored.affected.map(Number), [id]);
      assert.equal((await foodRow(id)).deleted_at, null);
      const back = await q(`SELECT calories FROM public.food_log_daily WHERE day = '2026-10-20'`);
      assert.equal(back.length, 1);
      assert.equal(Number(back[0].calories), 450);
    });

    test('(j) the delete_log_entry description asks for confirmation before deleting more than 3 items', async () => {
      const tools = await listTools(port);
      const names = tools.map((t) => t.name);
      for (const n of ['get_day_summary', 'update_log_entry', 'delete_log_entry', 'mark_day_complete']) {
        assert.ok(names.includes(n), `${n} missing from tools/list: ${names.join(', ')}`);
      }
      const tool = tools.find((t) => t.name === 'delete_log_entry');
      assert.equal(typeof tool.description, 'string');
      assert.match(tool.description, /confirm/i);
      assert.match(tool.description, /\b(3|three)\b/i);
    });
  });

  // ---------------------------------------------------------------------------
  // mark_day_complete
  // ---------------------------------------------------------------------------
  describe('mark_day_complete', () => {
    test('(i) sets nutrition_daily.logged_complete for that day (and upserts)', async () => {
      const DAY = '2026-10-19';
      await insertFood({ eaten_at: '2026-10-19T12:00:00-07:00', meal: 'lunch', description: 'Wrap', calories: 520 });
      const before_ = await q('SELECT logged_complete FROM public.nutrition_daily WHERE day = $1', [DAY]);
      assert.equal(before_.length, 1);
      assert.equal(before_[0].logged_complete, null);

      await callOk(port, 'mark_day_complete', { day: DAY, complete: true });
      let rows = await q('SELECT logged_complete FROM public.nutrition_daily WHERE day = $1', [DAY]);
      assert.equal(rows[0].logged_complete, true);

      await callOk(port, 'mark_day_complete', { day: DAY, complete: false });
      rows = await q('SELECT logged_complete FROM public.nutrition_daily WHERE day = $1', [DAY]);
      assert.equal(rows[0].logged_complete, false);
    });
  });
});
