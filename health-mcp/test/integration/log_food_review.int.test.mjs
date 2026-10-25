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
    OAUTH_STATE_PATH: path.join(os.tmpdir(), `health-mcp-t6-review-${crypto.randomUUID()}.json`),
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


function oneItem(eaten_at, calories = 100) {
  return [{ description: 'Apple', meal: 'snack', eaten_at, calories, protein_g: 0, carbs_g: 25, fat_g: 0, confidence: 'med', match_source: 'estimate' }];
}

describe('log_food review fixes', () => {
  let server;
  let port;
  let pools;
  let writer;

  before(async () => {
    await resetDb();
    await freshInstall();
    const config = loadConfig(envFromTestUrl({ WRITE_RATE_LIMIT_PER_HOUR: '3' }));
    pools = createPools(config);
    const app = createApp({ config, pool: pools.read, writePool: pools.write, registerTools: registerNutritionTools });
    ({ server, port } = await listen(app));
    writer = await writerPool();
  });

  after(async () => {
    await stopApp(server);
    await pools?.read?.end().catch(() => {});
    await pools?.write?.end().catch(() => {});
    await closePools();
  });

  test('invalid confirm calls and duplicate replays do not consume rate-limit tokens', async () => {
    const eaten_at = eatenAtNow();
    for (let i = 0; i < 4; i++) {
      const err = await callErr(port, { items: oneItem(eaten_at, -5), confirm: true });
      assert.equal(err.code, 'VALIDATION_ERROR');
    }
    const request_id = crypto.randomUUID();
    const first = await callOk(port, { request_id, items: oneItem(eaten_at), confirm: true });
    assert.equal(first.duplicate, false);
    for (let i = 0; i < 4; i++) {
      const again = await callOk(port, { request_id, items: oneItem(eaten_at), confirm: true });
      assert.equal(again.duplicate, true);
    }
    const second = await callOk(port, { items: oneItem(eaten_at), confirm: true });
    assert.equal(second.duplicate, false);
  });

  test('replay of a soft-deleted request returns duplicate: true with no live rows', async () => {
    const eaten_at = eatenAtNow();
    const request_id = crypto.randomUUID();
    const first = await callOk(port, { request_id, items: oneItem(eaten_at), confirm: true });
    await writer.query('UPDATE food_log SET deleted_at = now() WHERE request_id = $1::uuid', [request_id]);
    const again = await callOk(port, { request_id, items: oneItem(eaten_at), confirm: true });
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.logged, []);
    assert.ok(first.logged.length === 1);
  });

  test('preview projects integer calories', async () => {
    const eaten_at = eatenAtNow();
    const body = await callOk(port, { items: oneItem(eaten_at, 100.5) });
    for (const t of Object.values(body.day_totals)) assert.ok(Number.isInteger(t.calories), `calories ${t.calories}`);
  });
});
