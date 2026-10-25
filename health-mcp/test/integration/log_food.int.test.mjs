// T6 spec (integration): the log_food tool, build-plan §5.3 plus D4
// (preview without `confirm`, insert with `confirm: true`).
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Module interface assumed:
//   tools/nutrition/index.mjs
//     registerNutritionTools(server, { pool, writePool, config, guard })
//       Matches createApp's `registerTools` hook (T5). Registers `log_food`
//       only when config.WRITES_ENABLED is true.
//
// Tool contract assumed (all responses are JSON in content[0].text):
//   preview (confirm omitted or false): writes nothing and returns
//     { preview: true, would_log: [row...], warnings: [...], day_totals: { 'YYYY-MM-DD': totals } }
//     where day_totals is the projection: current food_log_daily + would-be rows.
//   confirm: true: inserts all items in one transaction and returns
//     { preview: false, logged: [row...], warnings: [...], day_totals: {...}, duplicate: false|true }
//   row: { id (confirmed only), day: 'YYYY-MM-DD', meal, description, calories,
//          protein_g, carbs_g, fat_g, ..., confidence, match_source, computed_by_server }
//     with nutrient values as JS numbers.
//   totals: { calories, protein_g, carbs_g, fat_g, items, ... } as JS numbers.
//   errors: isError: true, text {"error":{"code","message","item_index"?,"field"?}}.
//
// Time: the handler uses the real clock, so items use eaten_at = now - 1 h.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  resetDb,
  freshInstall,
  closePools,
  readonlyPool,
  writerPool,
  READONLY_TEST_PASSWORD,
  WRITER_TEST_PASSWORD,
} from '../helpers/testdb.mjs';
import { loadConfig } from '../../config.mjs';
import { createApp } from '../../app.mjs';
import { createPools } from '../../db.mjs';
import { registerNutritionTools } from '../../tools/nutrition/index.mjs';

const API_KEY = 'k'.repeat(40);

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
    OAUTH_STATE_PATH: path.join(os.tmpdir(), `health-mcp-t6-int-${crypto.randomUUID()}.json`),
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
    assert.fail(`tool output is not JSON: ${text}`);
  }
  return { result: msg.result, body };
}

async function callOk(port, args) {
  const { result, body } = await callTool(port, 'log_food', args);
  assert.notEqual(result.isError, true, `expected success, got ${JSON.stringify(body)}`);
  return body;
}

async function callErr(port, args) {
  const { result, body } = await callTool(port, 'log_food', args);
  assert.equal(result.isError, true, `expected an error, got ${JSON.stringify(body)}`);
  assert.ok(body.error, `expected {"error":{...}}, got ${JSON.stringify(body)}`);
  assert.equal(typeof body.error.message, 'string');
  return body.error;
}

function eatenAtNow() {
  return new Date(Date.now() - 3600 * 1000).toISOString();
}

function threeItems(eaten_at) {
  return [
    {
      description: 'Scrambled eggs',
      meal: 'breakfast',
      eaten_at,
      quantity: 2,
      unit: 'large egg',
      calories: 180,
      protein_g: 12,
      carbs_g: 2,
      fat_g: 14,
      confidence: 'med',
      match_source: 'estimate',
    },
    {
      // USDA without USDA tables: explicit nutrients plus fdc_id (Non-goal: no computation).
      description: 'Whole wheat toast',
      meal: 'breakfast',
      eaten_at,
      grams: 30,
      calories: 80,
      protein_g: 4,
      carbs_g: 14,
      fat_g: 1,
      confidence: 'med',
      match_source: 'usda',
      fdc_id: 123456,
    },
    {
      description: 'Latte',
      meal: 'breakfast',
      eaten_at,
      calories: 190,
      protein_g: 10,
      carbs_g: 18,
      fat_g: 9,
      fiber_g: 0,
      sugar_g: 16,
      sodium_mg: 150,
      confidence: 'low',
      match_source: 'restaurant',
      ref_label: 'Corner cafe',
    },
  ];
}
const THREE_SUM = { calories: 450, protein_g: 26, carbs_g: 34, fat_g: 24 };

describe('log_food (writes enabled)', () => {
  let pools;
  let server;
  let port;
  let ro;
  let writer;

  async function foodLogCount() {
    const { rows } = await ro.query('SELECT count(*)::int AS n FROM food_log');
    return rows[0].n;
  }

  async function laDay(eaten_at) {
    const { rows } = await ro.query(
      `SELECT (($1::timestamptz) AT TIME ZONE 'America/Los_Angeles')::date::text AS d`,
      [eaten_at]
    );
    return rows[0].d;
  }

  async function dailyRow(day) {
    const { rows } = await ro.query('SELECT * FROM food_log_daily WHERE day = $1::date', [day]);
    return rows[0] || null;
  }

  async function insertFavorite({ name, archived = false }) {
    const { rows } = await writer.query(
      `INSERT INTO my_foods (name, serving_qty, serving_unit, serving_grams, calories, protein_g, carbs_g, fat_g,
                             fiber_g, sugar_g, sodium_mg, confidence, basis, archived_at)
       VALUES ($1, 1, 'bowl', 320, 410, 22, 58, 10, 8, 14, 180, 'high', 'recipe',
               CASE WHEN $2::boolean THEN now() ELSE NULL END)
       RETURNING id`,
      [name, archived]
    );
    return Number(rows[0].id);
  }

  before(async () => {
    await resetDb();
    await freshInstall();
    const config = loadConfig(envFromTestUrl());
    pools = createPools(config);
    assert.ok(pools.write, 'expected a write pool with WRITE_TOOLS_ENABLED=true');
    const app = createApp({ config, pool: pools.read, writePool: pools.write, registerTools: registerNutritionTools });
    ({ server, port } = await listen(app));
    ro = await readonlyPool();
    writer = await writerPool();
  });

  after(async () => {
    await stopApp(server);
    await pools?.read?.end().catch(() => {});
    await pools?.write?.end().catch(() => {});
    await closePools();
  });

  test('(n) log_food is listed and its description mentions confirm and confidence', async () => {
    const tools = await listTools(port);
    const tool = tools.find((t) => t.name === 'log_food');
    assert.ok(tool, `log_food missing from tools/list: ${tools.map((t) => t.name).join(', ')}`);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.includes('confirm'), `description lacks "confirm": ${tool.description}`);
    assert.ok(tool.description.includes('confidence'), `description lacks "confidence": ${tool.description}`);
  });

  test('(g) without confirm: 3 computed rows, projected day_totals, nothing written', async () => {
    const eaten_at = eatenAtNow();
    const day = await laDay(eaten_at);
    const before_ = await foodLogCount();
    const existing = await dailyRow(day);

    const body = await callOk(port, { items: threeItems(eaten_at) });

    assert.equal(await foodLogCount(), before_, 'preview must not insert rows');
    assert.equal(body.preview, true);
    assert.ok(Array.isArray(body.would_log), `expected would_log array, got ${JSON.stringify(body)}`);
    assert.equal(body.would_log.length, 3);
    const items = threeItems(eaten_at);
    body.would_log.forEach((row, i) => {
      assert.equal(row.id ?? null, null, 'a preview row has no id');
      assert.equal(row.day, day);
      assert.equal(row.meal, 'breakfast');
      assert.equal(row.description, items[i].description);
      assert.equal(row.match_source, items[i].match_source);
      assert.equal(row.confidence, items[i].confidence);
      for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g']) {
        assert.equal(typeof row[k], 'number', `${k} must be a JS number`);
        assert.equal(row[k], items[i][k]);
      }
      assert.equal(row.computed_by_server, false);
    });

    assert.ok(body.day_totals && body.day_totals[day], `expected day_totals for ${day}, got ${JSON.stringify(body)}`);
    const t = body.day_totals[day];
    const base = existing
      ? { calories: Number(existing.calories), protein_g: Number(existing.protein_g), carbs_g: Number(existing.carbs_g), fat_g: Number(existing.fat_g), items: Number(existing.items) }
      : { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, items: 0 };
    assert.equal(t.calories, base.calories + THREE_SUM.calories);
    assert.equal(t.protein_g, base.protein_g + THREE_SUM.protein_g);
    assert.equal(t.carbs_g, base.carbs_g + THREE_SUM.carbs_g);
    assert.equal(t.fat_g, base.fat_g + THREE_SUM.fat_g);
    assert.equal(t.items, base.items + 3);
  });

  test('(h) confirm: true inserts 3 rows and day_totals match food_log_daily', async () => {
    const eaten_at = eatenAtNow();
    const day = await laDay(eaten_at);
    const before_ = await foodLogCount();

    const body = await callOk(port, { items: threeItems(eaten_at), confirm: true });

    assert.equal(await foodLogCount(), before_ + 3);
    assert.equal(body.duplicate, false);
    assert.ok(Array.isArray(body.logged), `expected logged array, got ${JSON.stringify(body)}`);
    assert.equal(body.logged.length, 3);
    const items = threeItems(eaten_at);
    const ids = body.logged.map((r) => Number(r.id));
    for (const id of ids) assert.ok(Number.isInteger(id) && id > 0, `bad id in ${JSON.stringify(body.logged)}`);
    const { rows } = await ro.query(
      'SELECT id, description, calories, day::text AS day FROM food_log WHERE id = ANY($1::bigint[]) ORDER BY id',
      [ids]
    );
    assert.equal(rows.length, 3, 'returned ids must exist in food_log');
    body.logged.forEach((row, i) => {
      assert.equal(row.day, day);
      assert.equal(row.description, items[i].description);
      assert.equal(typeof row.calories, 'number');
      assert.equal(row.calories, items[i].calories);
    });

    const daily = await dailyRow(day);
    assert.ok(daily, 'expected a food_log_daily row');
    const t = body.day_totals && body.day_totals[day];
    assert.ok(t, `expected day_totals for ${day}, got ${JSON.stringify(body)}`);
    for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g', 'items']) {
      assert.equal(typeof t[k], 'number', `day_totals.${k} must be a JS number`);
      assert.equal(t[k], Number(daily[k]), `day_totals.${k}`);
    }
  });

  test('(i) an invalid item 2 (missing calories) inserts nothing: VALIDATION_ERROR, item_index 1', async () => {
    const eaten_at = eatenAtNow();
    const items = threeItems(eaten_at);
    delete items[1].calories;
    const before_ = await foodLogCount();
    const err = await callErr(port, { items, confirm: true });
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.item_index, 1);
    assert.equal(err.field, 'calories');
    assert.equal(await foodLogCount(), before_);
  });

  test('(i) an invalid item 2 (calories out of range) inserts nothing: VALIDATION_ERROR, item_index 1', async () => {
    const eaten_at = eatenAtNow();
    const items = threeItems(eaten_at);
    items[1].calories = 6000;
    const before_ = await foodLogCount();
    const err = await callErr(port, { items, confirm: true });
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.item_index, 1);
    assert.equal(err.field, 'calories');
    assert.equal(await foodLogCount(), before_);
  });

  test('(j) the same request_id twice gives one set of rows; the second has duplicate: true', async () => {
    const eaten_at = eatenAtNow();
    const request_id = crypto.randomUUID();
    const before_ = await foodLogCount();

    const first = await callOk(port, { request_id, items: threeItems(eaten_at), confirm: true });
    assert.equal(first.duplicate, false);
    assert.equal(first.logged.length, 3);
    assert.equal(await foodLogCount(), before_ + 3);

    const second = await callOk(port, { request_id, items: threeItems(eaten_at), confirm: true });
    assert.equal(second.duplicate, true);
    assert.equal(await foodLogCount(), before_ + 3, 'a duplicate request must not insert');
    assert.deepEqual(
      second.logged.map((r) => Number(r.id)).sort((a, b) => a - b),
      first.logged.map((r) => Number(r.id)).sort((a, b) => a - b)
    );

    const { rows } = await ro.query('SELECT count(*)::int AS n FROM food_log WHERE request_id = $1::uuid', [request_id]);
    assert.equal(rows[0].n, 3);
  });

  test('(k) a favorite with servings 1.5 and no nutrients stores 1.5x its values, computed_by_server', async () => {
    const my_food_id = await insertFavorite({ name: 'Usual oatmeal' });
    const eaten_at = eatenAtNow();

    const body = await callOk(port, {
      items: [
        {
          description: 'Usual oatmeal',
          meal: 'breakfast',
          eaten_at,
          match_source: 'favorite',
          my_food_id,
          servings: 1.5,
          confidence: 'high',
        },
      ],
      confirm: true,
    });

    assert.equal(body.logged.length, 1);
    const row = body.logged[0];
    assert.equal(row.computed_by_server, true);
    assert.equal(row.calories, 615);
    assert.equal(row.protein_g, 33);
    assert.equal(row.carbs_g, 87);
    assert.equal(row.fat_g, 15);

    const { rows } = await ro.query(
      `SELECT calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, my_food_id, match_source
         FROM food_log WHERE id = $1::bigint`,
      [Number(row.id)]
    );
    assert.equal(rows.length, 1);
    const s = rows[0];
    assert.equal(Number(s.calories), 615);
    assert.equal(Number(s.protein_g), 33);
    assert.equal(Number(s.carbs_g), 87);
    assert.equal(Number(s.fat_g), 15);
    assert.equal(Number(s.fiber_g), 12);
    assert.equal(Number(s.sugar_g), 21);
    assert.equal(Number(s.sodium_mg), 270);
    assert.equal(Number(s.my_food_id), my_food_id);
    assert.equal(s.match_source, 'favorite');
  });

  test('(l) an archived my_food_id gives NOT_FOUND and inserts nothing', async () => {
    const my_food_id = await insertFavorite({ name: 'Old granola', archived: true });
    const before_ = await foodLogCount();
    const err = await callErr(port, {
      items: [
        { description: 'Old granola', meal: 'snack', eaten_at: eatenAtNow(), match_source: 'favorite', my_food_id, confidence: 'high' },
      ],
      confirm: true,
    });
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(await foodLogCount(), before_);
  });

  test('(l) an unknown my_food_id gives NOT_FOUND, with or without confirm', async () => {
    const item = {
      description: 'Mystery bowl',
      meal: 'lunch',
      eaten_at: eatenAtNow(),
      match_source: 'favorite',
      my_food_id: 999999,
      confidence: 'high',
    };
    const before_ = await foodLogCount();
    assert.equal((await callErr(port, { items: [item], confirm: true })).code, 'NOT_FOUND');
    assert.equal((await callErr(port, { items: [item] })).code, 'NOT_FOUND');
    assert.equal(await foodLogCount(), before_);
  });
});

describe('(m) log_food with WRITE_TOOLS_ENABLED=false', () => {
  let pools;
  let server;
  let port;

  before(async () => {
    const config = loadConfig(envFromTestUrl({ WRITE_TOOLS_ENABLED: 'false' }));
    pools = createPools(config);
    const app = createApp({ config, pool: pools.read, writePool: pools.write ?? null, registerTools: registerNutritionTools });
    ({ server, port } = await listen(app));
  });

  after(async () => {
    await stopApp(server);
    await pools?.read?.end().catch(() => {});
    await pools?.write?.end().catch(() => {});
    await closePools();
  });

  test('tools/list does not include log_food', async () => {
    const names = (await listTools(port)).map((t) => t.name);
    assert.ok(names.includes('query'), `read tools must still be listed: ${names.join(', ')}`);
    assert.ok(!names.includes('log_food'), `log_food must be absent: ${names.join(', ')}`);
  });
});
