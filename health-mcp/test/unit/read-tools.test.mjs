// T1 spec: pins the current behavior of the health-mcp read-only server after
// the module split (config.mjs, app.mjs, tools/read.mjs). No database, no
// network: the app is served on 127.0.0.1 with an ephemeral port and a fake pool.
//
// Module interface assumed by these tests:
//   config.mjs      export function loadConfig(env)          -> config object, throws on bad env
//   app.mjs         export function createApp({ config, pool }) -> express app
//   tools/read.mjs  export function assertReadOnlySql(sql)    -> trimmed sql, throws on reject

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { assertReadOnlySql } from '../../tools/read.mjs';
import { loadConfig } from '../../config.mjs';
import { createApp } from '../../app.mjs';

const API_KEY = 'k'.repeat(40);

function baseEnv(overrides = {}) {
  return {
    DB_PASSWORD: 'test-password',
    MCP_API_KEY: API_KEY,
    // Nonexistent file: the OAuth router only reads it at startup.
    OAUTH_STATE_PATH: path.join(os.tmpdir(), `health-mcp-t1-${crypto.randomUUID()}.json`),
    ...overrides,
  };
}

function makeFakePool(rows = [{ one: 1 }]) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
    async connect() {
      throw new Error('fake pool: connect() not expected in T1 unit tests');
    },
    async end() {},
    on() {},
  };
}

// Raw http.request so the Host header can be set freely.
function request(port, { method = 'GET', path: reqPath = '/mcp', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: {
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Parses a JSON-RPC response that may come back as plain JSON or as SSE frames.
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

let rpcId = 0;
function mcpCall(port, method, params = {}, { bearer = API_KEY, host } = {}) {
  return request(port, {
    method: 'POST',
    path: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(host ? { host } : {}),
    },
    body: { jsonrpc: '2.0', id: ++rpcId, method, params },
  });
}

async function startApp(pool) {
  const app = createApp({ config: loadConfig(baseEnv()), pool });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  return { server, port: server.address().port };
}

function stopApp(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// (a) SQL guard
// ---------------------------------------------------------------------------
describe('(a) assertReadOnlySql', () => {
  const accepted = ['SELECT 1', 'with x as (select 1) select * from x', 'SELECT 1;'];
  const rejected = [
    'SELECT 1; SELECT 2',
    'INSERT INTO t VALUES (1)',
    "select 1 where 'x' = 'drop'",
    'DELETE FROM t',
    'update t set a=1',
  ];

  for (const sql of accepted) {
    test(`accepts ${JSON.stringify(sql)}`, () => {
      assert.doesNotThrow(() => assertReadOnlySql(sql));
    });
  }

  test('strips one trailing semicolon', () => {
    assert.equal(assertReadOnlySql('SELECT 1;'), 'SELECT 1');
  });

  for (const sql of rejected) {
    test(`rejects ${JSON.stringify(sql)}`, () => {
      assert.throws(() => assertReadOnlySql(sql), Error);
    });
  }
});

// ---------------------------------------------------------------------------
// (f) config
// ---------------------------------------------------------------------------
describe('(f) loadConfig', () => {
  test('accepts a valid env', () => {
    assert.doesNotThrow(() => loadConfig(baseEnv()));
  });

  test('accepts an MCP_API_KEY of exactly 32 chars', () => {
    assert.doesNotThrow(() => loadConfig(baseEnv({ MCP_API_KEY: 'a'.repeat(32) })));
  });

  test('throws when DB_PASSWORD is unset', () => {
    const env = baseEnv();
    delete env.DB_PASSWORD;
    assert.throws(() => loadConfig(env));
  });

  test('throws when DB_PASSWORD is empty', () => {
    assert.throws(() => loadConfig(baseEnv({ DB_PASSWORD: '' })));
  });

  test('throws when MCP_API_KEY is unset', () => {
    const env = baseEnv();
    delete env.MCP_API_KEY;
    assert.throws(() => loadConfig(env));
  });

  test('throws when MCP_API_KEY is shorter than 32 chars', () => {
    assert.throws(() => loadConfig(baseEnv({ MCP_API_KEY: 'a'.repeat(31) })));
  });
});

// ---------------------------------------------------------------------------
// (b)-(e) HTTP app
// ---------------------------------------------------------------------------
describe('HTTP app', () => {
  let server;
  let port;
  let pool;

  before(async () => {
    pool = makeFakePool([{ one: 1 }]);
    ({ server, port } = await startApp(pool));
  });

  after(async () => {
    await stopApp(server);
  });

  test('(b) query tool wraps the SQL with LIMIT 1000 and sends it to the pool', async () => {
    pool.calls.length = 0;
    const res = await mcpCall(port, 'tools/call', { name: 'query', arguments: { sql: 'SELECT 1' } });
    assert.equal(res.status, 200, res.text);
    const msg = parseRpc(res);
    assert.ok(msg.result, `expected a result, got ${res.text}`);
    assert.notEqual(msg.result.isError, true, res.text);

    assert.equal(pool.calls.length, 1);
    assert.equal(pool.calls[0].text, 'SELECT * FROM (SELECT 1) AS _q LIMIT 1000');
    assert.deepEqual(JSON.parse(msg.result.content[0].text), [{ one: 1 }]);
  });

  test('(b) query tool strips a trailing semicolon before wrapping', async () => {
    pool.calls.length = 0;
    const res = await mcpCall(port, 'tools/call', { name: 'query', arguments: { sql: 'SELECT 1;' } });
    assert.equal(res.status, 200, res.text);
    assert.equal(pool.calls.length, 1);
    assert.equal(pool.calls[0].text, 'SELECT * FROM (SELECT 1) AS _q LIMIT 1000');
  });

  test('(b) query tool rejects a write without touching the pool', async () => {
    pool.calls.length = 0;
    const res = await mcpCall(port, 'tools/call', { name: 'query', arguments: { sql: 'DELETE FROM t' } });
    assert.equal(res.status, 200, res.text);
    const msg = parseRpc(res);
    assert.equal(msg.result.isError, true);
    assert.equal(pool.calls.length, 0);
  });

  test('(c) a request with Host evil.example gets 421', async () => {
    const res = await mcpCall(port, 'tools/list', {}, { host: 'evil.example' });
    assert.equal(res.status, 421);
  });

  test('(c) Host evil.example gets 421 on any path, even unauthenticated', async () => {
    const res = await request(port, { method: 'GET', path: '/.well-known/oauth-protected-resource', headers: { host: 'evil.example' } });
    assert.equal(res.status, 421);
  });

  test('(d) POST /mcp with no bearer gets 401 and WWW-Authenticate with resource_metadata=', async () => {
    const res = await mcpCall(port, 'tools/list', {}, { bearer: null });
    assert.equal(res.status, 401);
    const wwwAuth = res.headers['www-authenticate'];
    assert.ok(wwwAuth, 'missing WWW-Authenticate header');
    assert.match(wwwAuth, /resource_metadata=/);
  });

  test('(d) POST /mcp with a wrong bearer gets 401', async () => {
    const res = await mcpCall(port, 'tools/list', {}, { bearer: 'x'.repeat(40) });
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'] || '', /resource_metadata=/);
  });

  test('(e) static-key tools/list returns exactly the three read tools with unchanged descriptions', async () => {
    const res = await mcpCall(port, 'tools/list');
    assert.equal(res.status, 200, res.text);
    const msg = parseRpc(res);
    assert.ok(msg.result && Array.isArray(msg.result.tools), `expected tools, got ${res.text}`);

    const byName = Object.fromEntries(msg.result.tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ['describe_table', 'list_tables', 'query']);

    assert.equal(
      byName.list_tables.description,
      'List tables and views in the health_pi database (public schema), with approximate row counts.'
    );
    assert.equal(
      byName.describe_table.description,
      'Show column names, types, and nullability for a table or view in the public schema.'
    );
    assert.equal(
      byName.query.description,
      'Run a single read-only SQL SELECT statement against the health_pi database and return the rows. ' +
        'Results are capped at 1000 rows. Writes and multi-statement input are rejected.'
    );
  });
});
