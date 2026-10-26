// T5 spec (f): with both pools configured, the `query` tool still runs as
// claude_readonly. (Lives here rather than in food_log_schema.int.test.mjs,
// which is a locked T4 spec file.)
//
// Needs TEST_DATABASE_URL (see harness.int.test.mjs). The suite fails, rather
// than skips, when it is unset.
//
// Module interface assumed (see test/unit/write-guard.test.mjs):
//   db.mjs   createPools(config) -> { read, write }
//   app.mjs  createApp({ config, pool, writePool })

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
  READONLY_TEST_PASSWORD,
  WRITER_TEST_PASSWORD,
} from '../helpers/testdb.mjs';
import { loadConfig } from '../../config.mjs';
import { createApp } from '../../app.mjs';
import { createPools } from '../../db.mjs';

const API_KEY = 'k'.repeat(40);

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
    OAUTH_STATE_PATH: path.join(os.tmpdir(), `health-mcp-t5-int-${crypto.randomUUID()}.json`),
  };
}

function mcpCall(port, method, params = {}) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
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

describe('(f) query tool pool routing with both pools configured', () => {
  let pools;
  let server;
  let port;

  before(async () => {
    await resetDb();
    await freshInstall();
    const config = loadConfig(envFromTestUrl());
    pools = createPools(config);
    assert.ok(pools.read, 'expected a read pool');
    assert.ok(pools.write, 'expected a write pool with WRITE_TOOLS_ENABLED=true');
    const app = createApp({ config, pool: pools.read, writePool: pools.write });
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    port = server.address().port;
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    await pools?.read?.end().catch(() => {});
    await pools?.write?.end().catch(() => {});
    await closePools();
  });

  test('the write pool really logs in as nutrition_writer', async () => {
    const { rows } = await pools.write.query('SELECT current_user AS u');
    assert.equal(rows[0].u, 'nutrition_writer');
  });

  test("the query tool's SELECT current_user AS u returns claude_readonly", async () => {
    const res = await mcpCall(port, 'tools/call', { name: 'query', arguments: { sql: 'SELECT current_user AS u' } });
    assert.equal(res.status, 200, res.text);
    const msg = parseRpc(res);
    assert.ok(msg.result, `expected a result, got ${res.text}`);
    assert.notEqual(msg.result.isError, true, res.text);
    assert.deepEqual(JSON.parse(msg.result.content[0].text), [{ u: 'claude_readonly' }]);
  });
});
