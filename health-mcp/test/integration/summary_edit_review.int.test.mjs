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
    OAUTH_STATE_PATH: path.join(os.tmpdir(), `health-mcp-t9-review-${crypto.randomUUID()}.json`),
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

async function callOk(port, name, args) {
  const { result, body } = await callTool(port, name, args);
  assert.notEqual(result.isError, true, `${name}: expected success, got ${JSON.stringify(body)}`);
  return body;
}

async function callErr(port, name, args) {
  const { result, body } = await callTool(port, name, args);
  assert.equal(result.isError, true, `${name}: expected an error, got ${JSON.stringify(body)}`);
  assert.ok(body.error);
  return body.error;
}

const FROZEN_NOW = new Date('2026-10-25T12:00:00-07:00');

describe('T9 review fixes', () => {
  let server;
  let port;
  let pools;
  let admin;

  const q = async (sql, params) => (await admin.query(sql, params)).rows;
  async function insertFood(overrides = {}) {
    const row = {
      eaten_at: '2026-10-24T12:00:00-07:00', meal: 'lunch', description: 't9 review', calories: 100,
      protein_g: 10, carbs_g: 10, fat_g: 2, confidence: 'med', match_source: 'estimate', created_via: 'claude_mcp',
      ...overrides,
    };
    const cols = Object.keys(row);
    const rows = await q(
      `INSERT INTO public.food_log (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => row[c])
    );
    return Number(rows[0].id);
  }

  before(async () => {
    await resetDb();
    await freshInstall();
    admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
    const config = loadConfig(envFromTestUrl({ WRITE_RATE_LIMIT_PER_HOUR: '5' }));
    pools = createPools(config);
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

  test('a day with no rows still reports the D5 goal and remaining', async () => {
    const [g] = await q(
      `SELECT base_calories, protein_g::float8 AS protein_g FROM public.nutrition_goals
        WHERE effective_from <= '2026-12-01' ORDER BY effective_from DESC LIMIT 1`
    );
    assert.ok(g, 'expected a seeded goal');
    const body = await callOk(port, 'get_day_summary', { day: '2026-12-01' });
    assert.equal(body.source, 'none');
    assert.ok(body.goals, JSON.stringify(body));
    assert.equal(body.goals.calories, Number(g.base_calories) + body.cycling_kcal);
    assert.equal(body.goals.protein_g, g.protein_g);
    assert.equal(body.remaining.calories, body.goals.calories);
    assert.equal(body.remaining.protein_g, body.goals.protein_g);
  });

  test('servings with one explicit macro still rescales the other nutrients', async () => {
    const [{ id: favId }] = await q(
      `INSERT INTO public.my_foods (name, serving_qty, serving_unit, serving_grams, calories, protein_g, carbs_g, fat_g,
                                    fiber_g, sugar_g, sodium_mg, confidence, basis)
       VALUES ('Review oats', 1, 'bowl', 320, 410, 22, 58, 10, 8, 14, 180, 'high', 'recipe') RETURNING id`
    );
    const id = await insertFood({
      description: 'Review oats', quantity: 1, unit: 'bowl', grams: 320, calories: 410, protein_g: 22, carbs_g: 58,
      fat_g: 10, fiber_g: 8, sugar_g: 14, sodium_mg: 180, confidence: 'high', match_source: 'favorite', my_food_id: Number(favId),
    });
    const body = await callOk(port, 'update_log_entry', { id, patch: { servings: 2, calories: 900 } });
    assert.equal(body.after.calories, 900);
    assert.equal(body.after.protein_g, 44);
    assert.equal(body.after.carbs_g, 116);
    assert.equal(body.after.fat_g, 20);
    assert.equal(body.after.fiber_g, 16);
    assert.equal(body.after.quantity, 2);
    assert.equal(body.after.grams, 640);
  });

  test('invalid day / eaten_at on update_log_entry do not consume rate-limit tokens', async () => {
    const id = await insertFood();
    for (let i = 0; i < 4; i++) {
      const e1 = await callErr(port, 'update_log_entry', { id, patch: { day: '2026-13-45' } });
      assert.equal(e1.code, 'VALIDATION_ERROR');
      const e2 = await callErr(port, 'update_log_entry', { id, patch: { eaten_at: 'not a date' } });
      assert.equal(e2.code, 'VALIDATION_ERROR');
    }
    for (let i = 0; i < 3; i++) {
      await callOk(port, 'update_log_entry', { id, patch: { notes: `n${i}` } });
    }
  });
});
