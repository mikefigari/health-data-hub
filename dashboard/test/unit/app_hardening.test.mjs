import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';

const TOKEN = 'A'.repeat(20) + 'aaaaaaaaaa_-12';

async function start() {
  const logs = [];
  const config = loadConfig({ DASHBOARD_TOKENS: TOKEN, DB_PASSWORD: 'x' });
  const pool = { async query() { return { rows: [] }; }, async connect() {}, async end() {}, on() {} };
  const app = createApp({ config, pool, log: (m) => logs.push(String(m)) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return {
    logs,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('uppercase /D/<token> never logs the raw token and is no-store', async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/D/${TOKEN}`);
    await res.text();
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await settle();
    assert.ok(s.logs.length > 0);
    for (const l of s.logs) assert.ok(!l.includes(TOKEN), l);
    const up = await fetch(`${s.base}/API/dashboard`);
    await up.text();
    assert.equal(up.headers.get('cache-control'), 'no-store');
  } finally { await s.close(); }
});

test('malformed path yields plain 400/404 without stack or raw param in body or logs', async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/d/%E0`);
    const body = await res.text();
    assert.ok([400, 404].includes(res.status), String(res.status));
    assert.equal(body, 'Not found');
    assert.ok(!/at .*\.m?js|%E0/.test(body));
    await settle();
    for (const l of s.logs) assert.ok(!/\n\s+at /.test(l) && !l.includes('%E0'), l);
  } finally { await s.close(); }
});
