// T7 review-fix tests: name conflicts must return CONFLICT naming the owner.

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

describe('save_favorite name conflicts', () => {
  let pools, server, port, ro;

  before(async () => {
    await resetDb();
    await freshInstall();
    const config = loadConfig(envFromTestUrl());
    pools = createPools(config);
    const app = createApp({ config, pool: pools.read, writePool: pools.write, registerTools: registerNutritionTools });
    ({ server, port } = await listen(app));
    ro = await readonlyPool();
  });

  after(async () => {
    await stopApp(server);
    await pools?.read?.end().catch(() => {});
    await pools?.write?.end().catch(() => {});
    await closePools();
  });

  async function activeId(name) {
    const { rows } = await ro.query('SELECT id FROM my_foods WHERE lower(name) = lower($1) AND archived_at IS NULL', [name]);
    assert.equal(rows.length, 1);
    return Number(rows[0].id);
  }

  test('create with an existing active name returns CONFLICT naming the owner', async () => {
    await callOk(port, 'save_favorite', favorite('Dup bowl'));
    const owner = await activeId('Dup bowl');
    const err = await callErr(port, 'save_favorite', favorite('dup BOWL'));
    assert.equal(err.code, 'CONFLICT');
    assert.ok(err.message.includes(String(owner)), err.message);
  });

  test('rename into an existing name returns CONFLICT naming the owner', async () => {
    await callOk(port, 'save_favorite', favorite('Rename target'));
    await callOk(port, 'save_favorite', favorite('Rename source'));
    const owner = await activeId('Rename target');
    const src = await activeId('Rename source');
    const err = await callErr(port, 'save_favorite', { id: src, name: 'rename target' });
    assert.equal(err.code, 'CONFLICT');
    assert.ok(err.message.includes(String(owner)), err.message);
    assert.equal(await activeId('Rename source'), src);
  });
});
