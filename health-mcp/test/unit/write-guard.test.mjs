// T5 spec: writer pool, kill switch, rate limit, auth info. No database, no
// network: pg pools are created but never connected (pg.Pool is lazy), and the
// app is served on 127.0.0.1 with an ephemeral port and fake pools.
//
// Module interface assumed by these tests (beyond T1's):
//   config.mjs     loadConfig(env) also reads WRITE_TOOLS_ENABLED ('true' enables
//                  writes; unset or anything else disables them), DB_WRITER_USER,
//                  DB_WRITER_PASSWORD (required when writes are enabled) and
//                  WRITE_RATE_LIMIT_PER_HOUR (default 120).
//   db.mjs         createPools(config) -> { read, write }: pg.Pool instances.
//                  `read` logs in as DB_USER; `write` logs in as DB_WRITER_USER
//                  with max 3, and is null/undefined when writes are disabled.
//   lib/write-guard.mjs
//                  createWriteGuard(config) -> guard, one per process:
//                    guard.check(tool)  null when the write may proceed (consumes
//                                       one token), otherwise an MCP tool result
//                                       { isError: true, content: [{ type: 'text',
//                                       text: '{"error":{"code",...}}' }] } with code
//                                       WRITES_DISABLED or RATE_LIMITED.
//                    guard.audit({ tool, authInfo, ids, kcal_delta })
//                                       emits one console.log JSON line
//                                       {evt:"write",tool,client,ids,kcal_delta},
//                                       client = authInfo.clientId.
//   app.mjs        createApp({ config, pool, writePool, registerTools }):
//                  T1's createApp({ config, pool }) still works. The app owns one
//                  write guard for the process. The optional registerTools(server,
//                  deps) is called for every per-request McpServer after the read
//                  tools, with deps.guard being that process-wide guard. mcpAuth sets
//                  req.auth so handlers see extra.authInfo.clientId ('static_key'
//                  for the static API key).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import crypto from 'node:crypto';

import { loadConfig } from '../../config.mjs';
import { createApp } from '../../app.mjs';
import { createPools } from '../../db.mjs';
import { createWriteGuard } from '../../lib/write-guard.mjs';

const API_KEY = 'k'.repeat(40);
const WRITER_PASSWORD = 'writer-test-password';

function baseEnv(overrides = {}) {
  return {
    DB_PASSWORD: 'test-password',
    MCP_API_KEY: API_KEY,
    OAUTH_STATE_PATH: path.join(os.tmpdir(), `health-mcp-t5-${crypto.randomUUID()}.json`),
    ...overrides,
  };
}

function writeEnv(overrides = {}) {
  return baseEnv({
    WRITE_TOOLS_ENABLED: 'true',
    DB_WRITER_USER: 'nutrition_writer',
    DB_WRITER_PASSWORD: WRITER_PASSWORD,
    ...overrides,
  });
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
      throw new Error('fake pool: connect() not expected in T5 unit tests');
    },
    async end() {},
    on() {},
  };
}

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
function mcpCall(port, method, params = {}, { bearer = API_KEY } = {}) {
  return request(port, {
    method: 'POST',
    path: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: { jsonrpc: '2.0', id: ++rpcId, method, params },
  });
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
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

function errorCode(result) {
  assert.ok(result, 'expected an error result, got nothing');
  assert.equal(result.isError, true, `expected isError: true, got ${JSON.stringify(result)}`);
  const text = result.content && result.content[0] && result.content[0].text;
  assert.equal(typeof text, 'string', `expected a text content item, got ${JSON.stringify(result)}`);
  const parsed = JSON.parse(text);
  assert.ok(parsed.error, `expected {"error":{...}}, got ${text}`);
  assert.equal(typeof parsed.error.message, 'string');
  return parsed.error.code;
}

// Captures console.log output while fn runs. Returns the formatted lines.
async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    lines.push(util.format(...args));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function writeLines(lines) {
  const out = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && obj.evt === 'write') out.push(obj);
  }
  return out;
}

const T1_READ_TOOLS = {
  list_tables: 'List tables and views in the health_pi database (public schema), with approximate row counts.',
  describe_table: 'Show column names, types, and nullability for a table or view in the public schema.',
  query:
    'Run a single read-only SQL SELECT statement against the health_pi database and return the rows. ' +
    'Results are capped at 1000 rows. Writes and multi-statement input are rejected.',
};

// ---------------------------------------------------------------------------
// (a) flag unset: unchanged tool list, no write pool
// ---------------------------------------------------------------------------
describe('(a) WRITE_TOOLS_ENABLED unset', () => {
  test('createPools creates no write pool when the flag is unset', async () => {
    const { read, write } = createPools(loadConfig(baseEnv()));
    try {
      assert.ok(read, 'expected a read pool');
      assert.equal(read.options.user, 'claude_readonly');
      assert.equal(write ?? null, null, 'no write pool may be created with writes disabled');
    } finally {
      await read?.end();
    }
  });

  test('createPools creates no write pool when the flag is "false"', async () => {
    const { read, write } = createPools(loadConfig(baseEnv({ WRITE_TOOLS_ENABLED: 'false', DB_WRITER_PASSWORD: WRITER_PASSWORD })));
    try {
      assert.equal(write ?? null, null);
    } finally {
      await read?.end();
    }
  });

  test('createPools creates the write pool as DB_WRITER_USER with max 3 when enabled', async () => {
    const { read, write } = createPools(loadConfig(writeEnv()));
    try {
      assert.equal(read.options.user, 'claude_readonly');
      assert.ok(write, 'expected a write pool with writes enabled');
      assert.notEqual(write, read);
      assert.equal(write.options.user, 'nutrition_writer');
      assert.equal(write.options.password, WRITER_PASSWORD);
      assert.equal(write.options.max, 3);
    } finally {
      await read?.end();
      await write?.end();
    }
  });

  test('static-key tools/list equals the T1(e) read tools', async () => {
    const app = createApp({ config: loadConfig(baseEnv()), pool: makeFakePool() });
    const { server, port } = await listen(app);
    try {
      const res = await mcpCall(port, 'tools/list');
      assert.equal(res.status, 200, res.text);
      const msg = parseRpc(res);
      assert.ok(msg.result && Array.isArray(msg.result.tools), `expected tools, got ${res.text}`);
      const byName = Object.fromEntries(msg.result.tools.map((t) => [t.name, t.description]));
      assert.deepEqual(byName, T1_READ_TOOLS);
    } finally {
      await stopApp(server);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) config
// ---------------------------------------------------------------------------
describe('(b) loadConfig with writes enabled', () => {
  test('throws when DB_WRITER_PASSWORD is unset', () => {
    const env = writeEnv();
    delete env.DB_WRITER_PASSWORD;
    assert.throws(() => loadConfig(env));
  });

  test('throws when DB_WRITER_PASSWORD is empty', () => {
    assert.throws(() => loadConfig(writeEnv({ DB_WRITER_PASSWORD: '' })));
  });

  test('accepts writes enabled with a writer password', () => {
    assert.doesNotThrow(() => loadConfig(writeEnv()));
  });

  test('does not require DB_WRITER_PASSWORD when writes are disabled', () => {
    assert.doesNotThrow(() => loadConfig(baseEnv()));
  });
});

// ---------------------------------------------------------------------------
// (c) rate limit
// ---------------------------------------------------------------------------
describe('(c) rate limit', () => {
  test('call N+1 within the window returns RATE_LIMITED (WRITE_RATE_LIMIT_PER_HOUR=3)', () => {
    const guard = createWriteGuard(loadConfig(writeEnv({ WRITE_RATE_LIMIT_PER_HOUR: '3' })));
    for (let i = 0; i < 3; i++) {
      assert.equal(guard.check('probe_write') ?? null, null, `call ${i + 1} should be allowed`);
    }
    assert.equal(errorCode(guard.check('probe_write')), 'RATE_LIMITED');
  });

  test('default limit is 120 per hour', () => {
    const guard = createWriteGuard(loadConfig(writeEnv()));
    for (let i = 0; i < 120; i++) {
      assert.equal(guard.check('probe_write') ?? null, null, `call ${i + 1} should be allowed`);
    }
    assert.equal(errorCode(guard.check('probe_write')), 'RATE_LIMITED');
  });

  test('the bucket is per process, shared across MCP requests', async () => {
    const config = loadConfig(writeEnv({ WRITE_RATE_LIMIT_PER_HOUR: '2' }));
    const app = createApp({
      config,
      pool: makeFakePool(),
      writePool: makeFakePool(),
      registerTools(server, deps) {
        server.registerTool(
          'probe_write',
          { title: 'Probe', description: 'Test-only write probe', inputSchema: {} },
          async () => {
            const denied = deps.guard.check('probe_write');
            if (denied) return denied;
            return { content: [{ type: 'text', text: '{"ok":true}' }] };
          }
        );
      },
    });
    const { server, port } = await listen(app);
    try {
      for (let i = 0; i < 2; i++) {
        const res = await mcpCall(port, 'tools/call', { name: 'probe_write', arguments: {} });
        assert.equal(res.status, 200, res.text);
        const msg = parseRpc(res);
        assert.ok(msg.result, res.text);
        assert.notEqual(msg.result.isError, true, `call ${i + 1} should be allowed: ${res.text}`);
      }
      const res = await mcpCall(port, 'tools/call', { name: 'probe_write', arguments: {} });
      assert.equal(res.status, 200, res.text);
      assert.equal(errorCode(parseRpc(res).result), 'RATE_LIMITED');
    } finally {
      await stopApp(server);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) audit log line and (e) authInfo, through the real app
// ---------------------------------------------------------------------------
describe('(d)/(e) write probe through the app', () => {
  const DESCRIPTION = 'Secret scrambled eggs with zz-unique-marker-7f3a';
  let server;
  let port;
  const seenAuth = [];

  before(async () => {
    const app = createApp({
      config: loadConfig(writeEnv()),
      pool: makeFakePool(),
      writePool: makeFakePool(),
      registerTools(mcpServer, deps) {
        mcpServer.registerTool(
          'probe_write',
          { title: 'Probe', description: 'Test-only write probe', inputSchema: {} },
          async (_args, extra) => {
            seenAuth.push(extra && extra.authInfo);
            const denied = deps.guard.check('probe_write');
            if (denied) return denied;
            deps.guard.audit({
              tool: 'probe_write',
              authInfo: extra && extra.authInfo,
              ids: [101, 102],
              kcal_delta: 410,
              // A careless guard that spreads its input would leak this.
              description: DESCRIPTION,
            });
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, description: DESCRIPTION }) }] };
          }
        );
      },
    });
    ({ server, port } = await listen(app));
  });

  after(async () => {
    await stopApp(server);
  });

  test('(e) handlers receive authInfo.clientId = static_key for the API key', async () => {
    seenAuth.length = 0;
    const res = await mcpCall(port, 'tools/call', { name: 'probe_write', arguments: {} });
    assert.equal(res.status, 200, res.text);
    assert.notEqual(parseRpc(res).result.isError, true, res.text);
    assert.equal(seenAuth.length, 1);
    assert.ok(seenAuth[0], 'handler got no authInfo');
    assert.equal(seenAuth[0].clientId, 'static_key');
  });

  test('(d) one JSON write line with exactly evt, tool, client, ids, kcal_delta; no description, no token', async () => {
    let res;
    const lines = await captureLog(async () => {
      res = await mcpCall(port, 'tools/call', { name: 'probe_write', arguments: {} });
    });
    assert.equal(res.status, 200, res.text);
    assert.notEqual(parseRpc(res).result.isError, true, res.text);

    const writes = writeLines(lines);
    assert.equal(writes.length, 1, `expected one write line, got: ${JSON.stringify(lines)}`);
    const line = writes[0];
    assert.deepEqual(Object.keys(line).sort(), ['client', 'evt', 'ids', 'kcal_delta', 'tool']);
    assert.equal(line.evt, 'write');
    assert.equal(line.tool, 'probe_write');
    assert.equal(line.client, 'static_key');
    assert.deepEqual(line.ids, [101, 102]);
    assert.equal(line.kcal_delta, 410);

    for (const l of lines) {
      assert.ok(!l.includes('zz-unique-marker-7f3a'), `log line leaks the description: ${l}`);
      assert.ok(!l.includes(API_KEY), `log line leaks the bearer token: ${l}`);
    }
  });

  test('(d) guard.audit alone emits a parseable line without the token in authInfo', async () => {
    const guard = createWriteGuard(loadConfig(writeEnv()));
    const lines = await captureLog(async () => {
      guard.audit({
        tool: 'log_food',
        authInfo: { clientId: 'client-abc', token: API_KEY, scopes: [] },
        ids: [7],
        kcal_delta: -250,
        description: DESCRIPTION,
      });
    });
    const writes = writeLines(lines);
    assert.equal(writes.length, 1, `expected one write line, got: ${JSON.stringify(lines)}`);
    assert.deepEqual(writes[0], { evt: 'write', tool: 'log_food', client: 'client-abc', ids: [7], kcal_delta: -250 });
    for (const l of lines) {
      assert.ok(!l.includes('zz-unique-marker-7f3a'), `log line leaks the description: ${l}`);
      assert.ok(!l.includes(API_KEY), `log line leaks the bearer token: ${l}`);
    }
  });
});
