// T7 spec (integration): save_favorite (build-plan §5.4) and search_foods
// (§5.2, favorites tier only; no USDA queries).
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Module interface assumed:
//   tools/nutrition/index.mjs
//     registerNutritionTools(server, { pool, writePool, config, guard })
//       Registers `save_favorite` (writes via writePool, nutrition_writer) and
//       `search_foods` (reads via pool, claude_readonly) alongside `log_food`
//       when config.WRITES_ENABLED is true.
//   (new files tools/nutrition/favorites.mjs and tools/nutrition/search.mjs are
//    reached only through registerNutritionTools; no direct imports here.)
//
// Tool contract assumed (all responses are JSON in content[0].text):
//   save_favorite input: { id?, name?, aliases?, remove_aliases?, serving_qty?, serving_unit?,
//     serving_grams?, calories?, protein_g?, carbs_g?, fat_g?, fiber_g?, sugar_g?, sodium_mg?,
//     confidence?, basis?, fdc_id?, from_log_id?, archive?, notes? }
//     The output shape is not pinned; these tests read my_foods / my_food_aliases directly.
//   search_foods input: { query, limit? }
//     output: { favorites: [ { my_food_id, name, matched_alias, exact, score, serving,
//                              per_serving, confidence, basis } ],
//               usda: [], note: '<string that mentions USDA>' }
//     favorites ordered exact desc, score desc, use_count desc; archived excluded.
//   errors: isError: true, text {"error":{"code","message","item_index"?,"field"?}}.
//     CONFLICT names the owning my_food_id in its message.

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
    OAUTH_STATE_PATH: path.join(os.tmpdir(), `health-mcp-t7-int-${crypto.randomUUID()}.json`),
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

// Wraps a pg.Pool so every query()/connect() call is counted.
function spyPool(real) {
  const calls = { query: 0, connect: 0 };
  const proxy = new Proxy(real, {
    get(target, prop) {
      if (prop === 'query' || prop === 'connect') {
        return (...args) => {
          calls[prop] += 1;
          return target[prop](...args);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return {
    pool: proxy,
    calls,
    total: () => calls.query + calls.connect,
    reset: () => {
      calls.query = 0;
      calls.connect = 0;
    },
  };
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

const OATMEAL = {
  name: 'Usual oatmeal',
  aliases: ['usual oatmeal'],
  serving_qty: 1,
  serving_unit: 'bowl',
  serving_grams: 320,
  calories: 410,
  protein_g: 22,
  carbs_g: 58,
  fat_g: 10,
  fiber_g: 8,
  sugar_g: 14,
  sodium_mg: 180,
  confidence: 'high',
  basis: 'recipe',
};

function favorite(name, extra = {}) {
  return {
    name,
    serving_qty: 1,
    serving_unit: 'serving',
    calories: 300,
    protein_g: 20,
    carbs_g: 30,
    fat_g: 10,
    confidence: 'med',
    basis: 'estimate',
    ...extra,
  };
}

describe('save_favorite and search_foods (writes enabled)', () => {
  let pools;
  let readSpy;
  let writeSpy;
  let server;
  let port;
  let ro;
  let writer;
  let oatmealId;

  async function activeId(name) {
    const { rows } = await ro.query(
      'SELECT id FROM my_foods WHERE lower(name) = lower($1) AND archived_at IS NULL',
      [name]
    );
    assert.equal(rows.length, 1, `expected one active my_foods row named ${name}`);
    return Number(rows[0].id);
  }

  async function aliasNorms(myFoodId) {
    const { rows } = await ro.query(
      'SELECT alias_norm FROM my_food_aliases WHERE my_food_id = $1::bigint ORDER BY alias_norm',
      [myFoodId]
    );
    return rows.map((r) => r.alias_norm);
  }

  async function search(query, extra = {}) {
    const body = await callOk(port, 'search_foods', { query, ...extra });
    assert.ok(Array.isArray(body.favorites), `expected favorites array, got ${JSON.stringify(body)}`);
    return body;
  }

  // Creates "Usual oatmeal" (and a competing, more-used "Oatmeal cookies") once.
  async function ensureOatmeal() {
    if (oatmealId) return oatmealId;
    await callOk(port, 'save_favorite', OATMEAL);
    oatmealId = await activeId('Usual oatmeal');
    await callOk(port, 'save_favorite', favorite('Oatmeal cookies', { aliases: ['oatmeal cookie'] }));
    const cookiesId = await activeId('Oatmeal cookies');
    await writer.query('UPDATE my_foods SET use_count = 50 WHERE id = $1::bigint', [cookiesId]);
    return oatmealId;
  }

  before(async () => {
    await resetDb();
    await freshInstall();
    const config = loadConfig(envFromTestUrl());
    pools = createPools(config);
    assert.ok(pools.write, 'expected a write pool with WRITE_TOOLS_ENABLED=true');
    readSpy = spyPool(pools.read);
    writeSpy = spyPool(pools.write);
    const app = createApp({
      config,
      pool: readSpy.pool,
      writePool: writeSpy.pool,
      registerTools: registerNutritionTools,
    });
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

  test('save_favorite and search_foods are listed', async () => {
    const res = await mcpCall(port, 'tools/list');
    assert.equal(res.status, 200, res.text);
    const names = parseRpc(res).result.tools.map((t) => t.name);
    assert.ok(names.includes('save_favorite'), `save_favorite missing: ${names.join(', ')}`);
    assert.ok(names.includes('search_foods'), `search_foods missing: ${names.join(', ')}`);
  });

  test('(a) "my usual oatmeal" returns Usual oatmeal first with exact: true', async () => {
    const id = await ensureOatmeal();
    const body = await search('my usual oatmeal');
    assert.ok(body.favorites.length >= 1, `expected favorites, got ${JSON.stringify(body)}`);
    const first = body.favorites[0];
    assert.equal(first.my_food_id, id, `expected Usual oatmeal first, got ${JSON.stringify(body.favorites)}`);
    assert.equal(first.exact, true);
    assert.equal(first.name, 'Usual oatmeal');
  });

  test('(b) "oatmeal" returns it with exact: false and score >= 0.4; usda is [] with a note', async () => {
    const id = await ensureOatmeal();
    const body = await search('oatmeal');
    const hit = body.favorites.find((f) => f.my_food_id === id);
    assert.ok(hit, `expected Usual oatmeal in ${JSON.stringify(body.favorites)}`);
    assert.equal(hit.exact, false);
    assert.equal(typeof hit.score, 'number');
    assert.ok(hit.score >= 0.4, `score ${hit.score} < 0.4`);
    assert.deepEqual(body.usda, []);
    assert.equal(typeof body.note, 'string', `expected a note string, got ${JSON.stringify(body)}`);
    assert.match(body.note, /usda/i);
  });

  test('(c) another favorite with alias "Usual  Oatmeal " gives CONFLICT naming the owner', async () => {
    const id = await ensureOatmeal();
    const err = await callErr(port, 'save_favorite', favorite('Weekend oatmeal', { aliases: ['Usual  Oatmeal '] }));
    assert.equal(err.code, 'CONFLICT');
    assert.match(
      err.message,
      new RegExp(`(^|\\D)${id}(\\D|$)`),
      `CONFLICT message must name my_food_id ${id}: ${err.message}`
    );
    const { rows } = await ro.query(`SELECT count(*)::int AS n FROM my_foods WHERE lower(name) = 'weekend oatmeal'`);
    assert.equal(rows[0].n, 0, 'a conflicting save must not leave a my_foods row behind');
  });

  test('(d) from_log_id copies nutrients and serving from the food_log row', async () => {
    const { rows } = await writer.query(
      `INSERT INTO food_log (eaten_at, meal, description, quantity, unit, grams, calories, protein_g, carbs_g,
                             fat_g, fiber_g, sugar_g, sodium_mg, confidence, match_source, ref_label, created_via)
       VALUES (now() - interval '1 hour', 'lunch', 'Fish tacos', 2, 'taco', 300, 520, 28, 46, 24, 6, 5, 900,
               'low', 'restaurant', 'Taco stand', 'claude_mcp')
       RETURNING id`
    );
    const logId = Number(rows[0].id);

    await callOk(port, 'save_favorite', {
      name: 'Taco stand fish tacos',
      from_log_id: logId,
      confidence: 'med',
      basis: 'restaurant',
    });
    const id = await activeId('Taco stand fish tacos');
    const { rows: fav } = await ro.query(
      `SELECT serving_qty, serving_unit, serving_grams, calories, protein_g, carbs_g, fat_g,
              fiber_g, sugar_g, sodium_mg
         FROM my_foods WHERE id = $1::bigint`,
      [id]
    );
    const f = fav[0];
    assert.equal(Number(f.serving_qty), 2);
    assert.equal(f.serving_unit, 'taco');
    assert.equal(Number(f.serving_grams), 300);
    assert.equal(Number(f.calories), 520);
    assert.equal(Number(f.protein_g), 28);
    assert.equal(Number(f.carbs_g), 46);
    assert.equal(Number(f.fat_g), 24);
    assert.equal(Number(f.fiber_g), 6);
    assert.equal(Number(f.sugar_g), 5);
    assert.equal(Number(f.sodium_mg), 900);
  });

  test('(e) archive: true removes it from search and frees its aliases', async () => {
    await callOk(port, 'save_favorite', favorite('Protein shake', { aliases: ['post ride shake'] }));
    const id = await activeId('Protein shake');
    const found = await search('post ride shake');
    assert.ok(found.favorites.some((f) => f.my_food_id === id), `expected it before archiving: ${JSON.stringify(found)}`);

    await callOk(port, 'save_favorite', { id, archive: true });

    const { rows } = await ro.query('SELECT archived_at FROM my_foods WHERE id = $1::bigint', [id]);
    assert.notEqual(rows[0].archived_at, null, 'archived_at must be set');
    assert.deepEqual(await aliasNorms(id), [], 'archiving must remove its aliases');
    for (const q of ['post ride shake', 'protein shake']) {
      const body = await search(q);
      assert.ok(!body.favorites.some((f) => f.my_food_id === id), `archived favorite returned for "${q}": ${JSON.stringify(body)}`);
    }

    // The freed name and alias can be reused by a new favorite.
    await callOk(port, 'save_favorite', favorite('Protein shake', { aliases: ['post ride shake'] }));
    const newId = await activeId('Protein shake');
    assert.notEqual(newId, id);
    assert.deepEqual(await aliasNorms(newId), ['post ride shake', 'protein shake']);
  });

  test('(f) search_foods runs on the read pool only', async () => {
    const id = await ensureOatmeal();
    readSpy.reset();
    writeSpy.reset();
    const body = await search('usual oatmeal');
    assert.ok(body.favorites.some((f) => f.my_food_id === id), `expected a hit: ${JSON.stringify(body)}`);
    assert.ok(readSpy.total() > 0, 'search_foods must query the read pool');
    assert.equal(writeSpy.total(), 0, `search_foods must not touch the write pool: ${JSON.stringify(writeSpy.calls)}`);
  });

  test('(g) the favorite name is always stored as an alias', async () => {
    await callOk(port, 'save_favorite', favorite('Turkey sandwich', { aliases: ['work lunch'] }));
    const id = await activeId('Turkey sandwich');
    assert.deepEqual(await aliasNorms(id), ['turkey sandwich', 'work lunch']);

    await callOk(port, 'save_favorite', favorite('Greek yogurt bowl'));
    const id2 = await activeId('Greek yogurt bowl');
    assert.deepEqual(await aliasNorms(id2), ['greek yogurt bowl']);

    const body = await search('Turkey Sandwich');
    const hit = body.favorites.find((f) => f.my_food_id === id);
    assert.ok(hit, `expected the favorite by its name: ${JSON.stringify(body)}`);
    assert.equal(hit.exact, true);

    // Renaming on update adds the new name as an alias.
    await callOk(port, 'save_favorite', { id, name: 'Turkey club' });
    assert.ok((await aliasNorms(id)).includes('turkey club'), `aliases after rename: ${await aliasNorms(id)}`);
  });
});
