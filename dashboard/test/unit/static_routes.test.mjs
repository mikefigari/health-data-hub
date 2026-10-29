// T5 spec: static asset routes under /assets and security headers on them.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';

const TOKEN = 'S'.repeat(34);
let server, base;

before(async () => {
  const config = loadConfig({ DASHBOARD_TOKENS: TOKEN, DB_PASSWORD: 'x' });
  const pool = { async query() { return { rows: [] }; }, async end() {}, on() {} };
  const app = createApp({ config, pool, now: () => new Date('2026-10-26T12:00:00Z'), log: () => {} });
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r()));
});

describe('static assets', () => {
  test('/assets/js/core.mjs is served revalidating (max-age=0) and CSP', async () => {
    const res = await fetch(`${base}/assets/js/core.mjs`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=0');
    assert.match(res.headers.get('content-type') || '', /javascript/);
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    await res.text();
  });

  test('/assets/vendor/echarts.min.js is served', async () => {
    const res = await fetch(`${base}/assets/vendor/echarts.min.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=0');
    const body = await res.text();
    assert.ok(body.length > 100000);
  });

  test('missing asset is 404', async () => {
    const res = await fetch(`${base}/assets/js/does-not-exist.mjs`);
    assert.equal(res.status, 404);
    await res.text();
  });
});
