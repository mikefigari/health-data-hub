// T2 spec: dashboard server skeleton (config, token gate, framing headers).
// No database, no network beyond 127.0.0.1: the app is served on an ephemeral
// port with a fake pool and exercised with the global fetch.
//
// Module interface assumed by these tests:
//   src/config.mjs  loadConfig(env) -> config object; throws on bad env (same
//                   pattern as health-mcp/config.mjs). Scalar settings keep their
//                   env names as keys (PORT, HOST, DB_USER, DB_NAME,
//                   FRAME_ANCESTORS, PLAN_KG_PER_WEEK).
//   src/app.mjs     createApp({ config, pool, now, log }) -> express app.
//                   `log` is an injected function that receives the access-log
//                   line(s). Also exports tokenMatches(candidate, tokens) -> boolean.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/config.mjs';
import { createApp, tokenMatches } from '../../src/app.mjs';

const TOKEN_A = 'A'.repeat(20) + 'aaaaaaaaaa_-12'; // 34 chars, allowed alphabet
const TOKEN_B = 'b'.repeat(16) + 'BBBBBBBBBBBBBBBB-_9'; // 35 chars
const WRONG = 'Z'.repeat(40);

const FRAME_ANCESTORS = 'https://www.notion.so https://notion.so https://*.notion.site';

function baseEnv(overrides = {}) {
  return {
    DASHBOARD_TOKENS: `${TOKEN_A},${TOKEN_B}`,
    DB_PASSWORD: 'test-password',
    ...overrides,
  };
}

function makeFakePool() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      throw new Error('fake pool: connect() not expected in T2 unit tests');
    },
    async end() {},
    on() {},
  };
}

function fixedNow() {
  return new Date('2026-10-26T12:00:00Z');
}

async function start(env, { log } = {}) {
  const config = loadConfig(env);
  const logs = [];
  const logFn =
    log ||
    ((...args) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  const app = createApp({ config, pool: makeFakePool(), now: fixedNow, log: logFn });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    logs,
    async close() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

// ---------------------------------------------------------------------------
// (a) DASHBOARD_TOKENS parsing and validation
// ---------------------------------------------------------------------------
describe('config: DASHBOARD_TOKENS', () => {
  test('a comma-separated list of valid tokens loads', () => {
    assert.doesNotThrow(() => loadConfig(baseEnv()));
    assert.doesNotThrow(() => loadConfig(baseEnv({ DASHBOARD_TOKENS: TOKEN_A })));
  });

  test('exactly 32 chars from [A-Za-z0-9_-] is accepted', () => {
    const t32 = 'abcdefghijklmnopqrstuvwxyzAB09_-';
    assert.equal(t32.length, 32);
    assert.doesNotThrow(() => loadConfig(baseEnv({ DASHBOARD_TOKENS: t32 })));
  });

  test('unset or empty DASHBOARD_TOKENS throws', () => {
    const env = baseEnv();
    delete env.DASHBOARD_TOKENS;
    assert.throws(() => loadConfig(env));
    assert.throws(() => loadConfig(baseEnv({ DASHBOARD_TOKENS: '' })));
  });

  test('any token shorter than 32 chars throws', () => {
    const t31 = 'x'.repeat(31);
    assert.throws(() => loadConfig(baseEnv({ DASHBOARD_TOKENS: t31 })));
    assert.throws(() => loadConfig(baseEnv({ DASHBOARD_TOKENS: `${TOKEN_A},${t31}` })));
    assert.throws(() => loadConfig(baseEnv({ DASHBOARD_TOKENS: `${t31},${TOKEN_B}` })));
  });

  test('any token with characters outside [A-Za-z0-9_-] throws', () => {
    for (const bad of ['.', '+', '/', '=', '!', '%', 'é']) {
      const tok = 'k'.repeat(35) + bad;
      assert.throws(
        () => loadConfig(baseEnv({ DASHBOARD_TOKENS: tok })),
        undefined,
        `token containing ${JSON.stringify(bad)} must be rejected`
      );
      assert.throws(
        () => loadConfig(baseEnv({ DASHBOARD_TOKENS: `${TOKEN_A},${tok}` })),
        undefined,
        `list containing a token with ${JSON.stringify(bad)} must be rejected`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// (b) DB_PASSWORD / demo mode and defaults
// ---------------------------------------------------------------------------
describe('config: DB_PASSWORD, demo mode, defaults', () => {
  test('missing DB_PASSWORD throws when not in demo mode', () => {
    const env = baseEnv();
    delete env.DB_PASSWORD;
    assert.throws(() => loadConfig(env));
    assert.throws(() => loadConfig({ ...env, DASHBOARD_DEMO: 'false' }));
  });

  test('DASHBOARD_DEMO=true needs no DB_PASSWORD', () => {
    const env = baseEnv({ DASHBOARD_DEMO: 'true' });
    delete env.DB_PASSWORD;
    assert.doesNotThrow(() => loadConfig(env));
  });

  test('DASHBOARD_DEMO=true still requires valid tokens', () => {
    const env = { DASHBOARD_DEMO: 'true' };
    assert.throws(() => loadConfig(env));
    assert.throws(() => loadConfig({ ...env, DASHBOARD_TOKENS: 'short' }));
  });

  test('defaults', () => {
    const c = loadConfig(baseEnv());
    assert.equal(String(c.PORT), '8878');
    assert.equal(c.HOST, '127.0.0.1');
    assert.equal(c.DB_USER, 'dashboard_ro');
    assert.equal(c.DB_NAME, 'health_pi');
    assert.equal(c.FRAME_ANCESTORS, FRAME_ANCESTORS);
    assert.equal(Number(c.PLAN_KG_PER_WEEK), 0.75);
  });
});

// ---------------------------------------------------------------------------
// App behaviour
// ---------------------------------------------------------------------------
describe('app: token gate, API guard, headers, logging', () => {
  let srv;

  before(async () => {
    srv = await start(baseEnv());
  });

  after(async () => {
    await srv.close();
  });

  // (c)
  test('GET /d/<valid> and /d/<valid>/ -> 200 text/html', async () => {
    for (const p of [`/d/${TOKEN_A}`, `/d/${TOKEN_A}/`, `/d/${TOKEN_B}`]) {
      const r = await get(srv.base, p);
      assert.equal(r.status, 200, `${p} status`);
      assert.match(String(r.headers.get('content-type')), /^text\/html/, `${p} content-type`);
    }
  });

  test('GET /d/<wrong> -> 404 with body exactly "Not found"', async () => {
    for (const p of [`/d/${WRONG}`, `/d/${TOKEN_A.slice(0, -1)}`, `/d/${TOKEN_A}x`, '/d/short']) {
      const r = await get(srv.base, p);
      assert.equal(r.status, 404, `${p} status`);
      assert.equal(r.text, 'Not found', `${p} body`);
    }
  });

  // (e)
  test('GET /api/dashboard without Authorization -> 401 {"error":"unauthorized"}', async () => {
    const r = await get(srv.base, '/api/dashboard');
    assert.equal(r.status, 401);
    assert.match(String(r.headers.get('content-type')), /application\/json/);
    assert.deepEqual(JSON.parse(r.text), { error: 'unauthorized' });
  });

  test('GET /api/dashboard with a wrong Bearer token -> 401', async () => {
    for (const auth of [`Bearer ${WRONG}`, `Bearer ${TOKEN_A}x`, 'Bearer ', `Basic ${TOKEN_A}`, TOKEN_A]) {
      const r = await get(srv.base, '/api/dashboard', { authorization: auth });
      assert.equal(r.status, 401, `Authorization: ${auth}`);
      assert.deepEqual(JSON.parse(r.text), { error: 'unauthorized' });
    }
  });

  test('a valid token in the query string is not accepted for /api', async () => {
    for (const q of [`token=${TOKEN_A}`, `access_token=${TOKEN_A}`, `t=${TOKEN_A}`]) {
      const r = await get(srv.base, `/api/dashboard?${q}`);
      assert.equal(r.status, 401, `?${q}`);
      assert.deepEqual(JSON.parse(r.text), { error: 'unauthorized' });
    }
  });

  test('a valid Bearer token passes the /api guard', async () => {
    for (const tok of [TOKEN_A, TOKEN_B]) {
      const r = await get(srv.base, '/api/dashboard', { authorization: `Bearer ${tok}` });
      assert.notEqual(r.status, 401, 'valid bearer must not be rejected by the guard');
    }
  });

  // (f)
  const headerCases = [
    ['GET /d/<valid>', () => [`/d/${TOKEN_A}`, {}]],
    ['GET /d/<wrong> (404)', () => [`/d/${WRONG}`, {}]],
    ['GET /api/dashboard (401)', () => ['/api/dashboard', {}]],
    ['GET /api/dashboard (valid bearer)', () => ['/api/dashboard', { authorization: `Bearer ${TOKEN_A}` }]],
    ['GET /healthz', () => ['/healthz', {}]],
    ['GET /no-such-path', () => ['/no-such-path', {}]],
  ];

  for (const [name, mk] of headerCases) {
    test(`security headers on ${name}`, async () => {
      const [p, h] = mk();
      const r = await get(srv.base, p, h);
      const csp = r.headers.get('content-security-policy');
      assert.ok(csp, 'Content-Security-Policy header present');
      const directives = csp
        .split(';')
        .map((d) => d.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
      for (const want of [
        `frame-ancestors ${FRAME_ANCESTORS}`,
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "base-uri 'none'",
      ]) {
        assert.ok(directives.includes(want), `CSP must contain directive "${want}"; got: ${csp}`);
      }
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(r.headers.get('x-frame-options'), null, 'X-Frame-Options must be absent');
      assert.equal(r.headers.get('x-powered-by'), null, 'X-Powered-By must be absent');
    });
  }

  // (g)
  test('/d/* and /api/* send Cache-Control: no-store', async () => {
    const cases = [
      [`/d/${TOKEN_A}`, {}],
      [`/d/${WRONG}`, {}],
      ['/api/dashboard', {}],
      ['/api/dashboard', { authorization: `Bearer ${TOKEN_A}` }],
    ];
    for (const [p, h] of cases) {
      const r = await get(srv.base, p, h);
      const cc = String(r.headers.get('cache-control') || '');
      assert.match(cc, /(^|,\s*)no-store(\s*,|$)/, `${p} Cache-Control: ${cc}`);
    }
  });

  // (h)
  test('GET /healthz -> 200 "ok" with no token', async () => {
    const r = await get(srv.base, '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.text.trim(), 'ok');
  });

  // (i)
  test('access log redacts the token in /d/<token>', async () => {
    srv.logs.length = 0;
    const r = await get(srv.base, `/d/${TOKEN_A}`);
    assert.equal(r.status, 200);
    const deadline = Date.now() + 1000;
    while (!srv.logs.some((l) => l.includes('/d/')) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 10));
    }
    const all = srv.logs.join('\n');
    assert.ok(all.includes('/d/[redacted]'), `access log must contain /d/[redacted]; got: ${all}`);
    assert.ok(!all.includes(TOKEN_A), 'access log must not contain the token');
  });

  test('access log redacts a wrong token too', async () => {
    srv.logs.length = 0;
    await get(srv.base, `/d/${WRONG}`);
    const deadline = Date.now() + 1000;
    while (!srv.logs.some((l) => l.includes('/d/')) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 10));
    }
    const all = srv.logs.join('\n');
    assert.ok(all.includes('/d/[redacted]'), `access log must contain /d/[redacted]; got: ${all}`);
    assert.ok(!all.includes(WRONG), 'access log must not contain the presented token');
  });
});

// ---------------------------------------------------------------------------
// (d) token rotation
// ---------------------------------------------------------------------------
describe('app: token rotation', () => {
  test('with tokens A,B both work; after reconfiguring with only B, A -> 404', async () => {
    const both = await start(baseEnv({ DASHBOARD_TOKENS: `${TOKEN_A},${TOKEN_B}` }));
    try {
      assert.equal((await get(both.base, `/d/${TOKEN_A}`)).status, 200);
      assert.equal((await get(both.base, `/d/${TOKEN_B}`)).status, 200);
      assert.notEqual(
        (await get(both.base, '/api/dashboard', { authorization: `Bearer ${TOKEN_A}` })).status,
        401
      );
    } finally {
      await both.close();
    }

    const onlyB = await start(baseEnv({ DASHBOARD_TOKENS: TOKEN_B }));
    try {
      const a = await get(onlyB.base, `/d/${TOKEN_A}`);
      assert.equal(a.status, 404);
      assert.equal(a.text, 'Not found');
      assert.equal((await get(onlyB.base, `/d/${TOKEN_B}`)).status, 200);
      assert.equal(
        (await get(onlyB.base, '/api/dashboard', { authorization: `Bearer ${TOKEN_A}` })).status,
        401
      );
    } finally {
      await onlyB.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (j) tokenMatches
// ---------------------------------------------------------------------------
describe('tokenMatches(candidate, tokens)', () => {
  const tokens = [TOKEN_A, TOKEN_B];

  test('returns true for a match (first or later token in the list)', () => {
    assert.strictEqual(tokenMatches(TOKEN_A, tokens), true);
    assert.strictEqual(tokenMatches(TOKEN_B, tokens), true);
  });

  test('returns false for a same-length mismatch', () => {
    const sameLen = TOKEN_A.slice(0, -1) + (TOKEN_A.endsWith('2') ? '3' : '2');
    assert.equal(sameLen.length, TOKEN_A.length);
    assert.strictEqual(tokenMatches(sameLen, tokens), false);
    assert.strictEqual(tokenMatches(WRONG, [TOKEN_A]), false);
  });

  test('returns false (and does not throw) for differing lengths', () => {
    assert.strictEqual(tokenMatches(TOKEN_A + 'x', tokens), false);
    assert.strictEqual(tokenMatches(TOKEN_A.slice(0, 10), tokens), false);
    assert.strictEqual(tokenMatches('', tokens), false);
  });
});
