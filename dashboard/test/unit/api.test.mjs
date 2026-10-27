// T4 spec (unit): GET /api/dashboard. No database: the app gets a fake pool
// and is served on an ephemeral 127.0.0.1 port, exercised with global fetch.
//
// Interface assumed by these tests:
//   src/app.mjs  createApp({ config, pool, now, log }) (from T2). The route
//                reads its inputs through src/queries.mjs fetchInputs(pool),
//                which may use pool.query(text | {text, ...}, params) or
//                pool.connect() -> client.query / client.release().
//   Response body = buildDashboard({ ...inputs, rangeDays, planKgPerWeek })
//   (src/aggregate.mjs), where planKgPerWeek = config.PLAN_KG_PER_WEEK.
//   The 60 s cache belongs to one createApp() instance: every test builds a
//   fresh app and expects an empty cache.
//
// The fake pool routes each query by the relation it names
// (body_weight_daily, nutrition_goals, nutrition_daily, ftp_history,
// workout_summary). A query that names none of them but calls now() is the
// "today" query; its single row answers the configured date for ANY column
// name. Dates come back as 'YYYY-MM-DD' strings.
//
// Demo mode has no database, so its `today` is the America/Los_Angeles
// calendar date of the injected now() (PLAN A7).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { buildDashboard } from '../../src/aggregate.mjs';
import { demoInputs } from '../../src/demo.mjs';

const TOKEN = 'T4specTokenAAAAAAAAAAAAAAAAAAAAAAAA_-1'; // 38 chars
const AUTH = { authorization: `Bearer ${TOKEN}` };

function env(overrides = {}) {
  return { DASHBOARD_TOKENS: TOKEN, DB_PASSWORD: 'unit-test-password', ...overrides };
}

// ---------------------------------------------------------------------------
// Fake pool
// ---------------------------------------------------------------------------
function classify(text) {
  const t = String(text).toLowerCase();
  if (t.includes('body_weight_daily')) return 'weights';
  if (t.includes('nutrition_goals')) return 'goals';
  if (t.includes('nutrition_daily')) return 'nutrition';
  if (t.includes('ftp_history')) return 'ftp';
  if (t.includes('workout_summary')) return 'rides';
  if (/now\s*\(\s*\)/.test(t)) return 'today';
  return 'other';
}

// A row that returns `value` for any column name the implementation picks.
function anyColumnRow(value) {
  return new Proxy(
    {},
    {
      get: (_t, k) => (typeof k === 'string' && k !== 'toJSON' && k !== 'then' ? value : undefined),
      has: () => true,
      ownKeys: () => ['today'],
      getOwnPropertyDescriptor: () => ({ value, enumerable: true, configurable: true, writable: true }),
    }
  );
}

function makeFakePool({ today = '2026-10-20', rows = {}, failOn = null, error = null } = {}) {
  const calls = [];
  let connects = 0;
  const run = async (q, params) => {
    const text = typeof q === 'string' ? q : (q && q.text) || '';
    const rowMode = q && typeof q === 'object' ? q.rowMode : undefined;
    const kind = classify(text);
    calls.push({ text, params, kind });
    if (failOn && failOn.includes(kind)) throw error;
    let out = kind === 'today' ? [anyColumnRow(today)] : (rows[kind] || []).map((r) => ({ ...r }));
    if (rowMode === 'array') out = out.map((r) => Object.keys(r).map((k) => r[k]));
    return { rows: out, rowCount: out.length, fields: [] };
  };
  return {
    calls,
    get connects() {
      return connects;
    },
    query: run,
    async connect() {
      connects += 1;
      return { query: run, release() {} };
    },
    async end() {},
    on() {},
  };
}

async function serve({ envOverrides = {}, pool, now = () => new Date('2026-10-26T12:00:00Z') }) {
  const config = loadConfig(env(envOverrides));
  const logs = [];
  const log = (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  const app = createApp({ config, pool, now, log });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  return {
    config,
    logs,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function get(base, path, headers = AUTH) {
  const res = await fetch(base + path, { headers, redirect: 'manual' });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

const dbQueries = (pool) => pool.calls.filter((c) => c.kind !== 'other').length;

// ---------------------------------------------------------------------------
// (a) range
// ---------------------------------------------------------------------------
describe('/api/dashboard: range parameter (a)', () => {
  for (const n of [7, 30, 90, 365]) {
    test(`range=${n} -> 200 with range_days ${n}`, async () => {
      const srv = await serve({ pool: makeFakePool() });
      try {
        const r = await get(srv.base, `/api/dashboard?range=${n}`);
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.range_days, n);
        assert.equal(r.json.nutrition.days.length, n);
      } finally {
        await srv.close();
      }
    });
  }

  test('no range -> 200 with range_days 30', async () => {
    const srv = await serve({ pool: makeFakePool() });
    try {
      const r = await get(srv.base, '/api/dashboard');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.range_days, 30);
    } finally {
      await srv.close();
    }
  });

  test('any other range -> 400 {"error":"bad_range"}', async () => {
    const pool = makeFakePool();
    const srv = await serve({ pool });
    try {
      for (const q of [
        'range=14',
        'range=abc',
        'range=-30',
        'range=30.5',
        'range=3650',
        'range=0',
        'range=7&range=30',
        'range[]=30',
        'range=30;DROP',
      ]) {
        const r = await get(srv.base, `/api/dashboard?${q}`);
        assert.equal(r.status, 400, `?${q} -> ${r.status} ${r.text}`);
        assert.deepEqual(r.json, { error: 'bad_range' }, `?${q}`);
      }
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) demo mode never touches the pool
// ---------------------------------------------------------------------------
describe('/api/dashboard: demo mode (b)', () => {
  // 03:00Z on 2026-10-27 is 20:00 PDT on 2026-10-26.
  const now = () => new Date('2026-10-27T03:00:00Z');
  const LA_TODAY = '2026-10-26';

  test('?demo=1 -> demo dashboard, pool never called', async () => {
    const pool = makeFakePool();
    const srv = await serve({ pool, now });
    try {
      const r = await get(srv.base, '/api/dashboard?demo=1&range=90');
      assert.equal(r.status, 200, r.text);
      assert.equal(pool.calls.length, 0, `pool.query called: ${pool.calls.map((c) => c.text).join(' | ')}`);
      assert.equal(pool.connects, 0, 'pool.connect called');
      const expected = buildDashboard({
        ...demoInputs(LA_TODAY),
        today: LA_TODAY,
        rangeDays: 90,
        planKgPerWeek: srv.config.PLAN_KG_PER_WEEK,
        proteinPctMin: srv.config.PROTEIN_PCT_MIN,
        proteinPctMax: srv.config.PROTEIN_PCT_MAX,
      });
      assert.deepEqual(r.json, JSON.parse(JSON.stringify(expected)));
    } finally {
      await srv.close();
    }
  });

  test('?demo=1 JSON carries protein % fields and none of the removed gram/goal-met fields (D12)', async () => {
    const pool = makeFakePool();
    const srv = await serve({ pool, now });
    try {
      const r = await get(srv.base, '/api/dashboard?demo=1&range=30');
      assert.equal(r.status, 200, r.text);
      const j = r.json;
      assert.equal(j.goals.protein_pct_min, 35);
      assert.equal(j.goals.protein_pct_max, 40);
      assert.ok(!('protein_g' in j.goals));
      assert.equal(typeof j.today_rings.protein_pct, 'number');
      assert.ok(typeof j.nutrition.summary.avg_protein_pct === 'number');
      assert.equal(typeof j.nutrition.summary.protein_days_in_range, 'number');
      assert.ok(j.nutrition.days.some((d) => typeof d.protein_pct === 'number' && typeof d.protein_in_range === 'boolean'));
      assert.ok(j.nutrition.weeks.every((w) => 'avg_protein_pct' in w));
      assert.ok(j.calendar.days.every((d) => typeof d.protein_in_range === 'boolean'));
      assert.ok(!/goal_protein_g|protein_days_met|protein_met|avg_protein_g/.test(r.text), 'removed field present');
    } finally {
      await srv.close();
    }
  });

  test('PROTEIN_PCT_MIN/MAX env reach the API goals echo', async () => {
    const pool = makeFakePool();
    const srv = await serve({ pool, now, envOverrides: { PROTEIN_PCT_MIN: '30', PROTEIN_PCT_MAX: '45' } });
    try {
      const r = await get(srv.base, '/api/dashboard?demo=1&range=7');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.goals.protein_pct_min, 30);
      assert.equal(r.json.goals.protein_pct_max, 45);
    } finally {
      await srv.close();
    }
  });

  test('DASHBOARD_DEMO=true -> demo dashboard without ?demo, pool never called', async () => {
    const pool = makeFakePool();
    const srv = await serve({ pool, now, envOverrides: { DASHBOARD_DEMO: 'true' } });
    try {
      const r = await get(srv.base, '/api/dashboard?range=7');
      assert.equal(r.status, 200, r.text);
      const r2 = await get(srv.base, '/api/dashboard');
      assert.equal(r2.status, 200, r2.text);
      assert.equal(pool.calls.length, 0, `pool.query called: ${pool.calls.map((c) => c.text).join(' | ')}`);
      assert.equal(pool.connects, 0, 'pool.connect called');
      const expected = buildDashboard({
        ...demoInputs(LA_TODAY),
        today: LA_TODAY,
        rangeDays: 7,
        planKgPerWeek: srv.config.PLAN_KG_PER_WEEK,
        proteinPctMin: srv.config.PROTEIN_PCT_MIN,
        proteinPctMax: srv.config.PROTEIN_PCT_MAX,
      });
      assert.deepEqual(r.json, JSON.parse(JSON.stringify(expected)));
      assert.equal(r2.json.range_days, 30);
      assert.equal(r2.json.today, LA_TODAY);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) 60 s in-memory cache
// ---------------------------------------------------------------------------
describe('/api/dashboard: cache (c)', () => {
  test('two calls within 60 s query the pool once', async () => {
    const pool = makeFakePool();
    const srv = await serve({ pool });
    try {
      const a = await get(srv.base, '/api/dashboard?range=30');
      assert.equal(a.status, 200, a.text);
      const afterFirst = dbQueries(pool);
      assert.ok(afterFirst > 0, 'first call must query the pool');
      const b = await get(srv.base, '/api/dashboard?range=30');
      assert.equal(b.status, 200, b.text);
      assert.equal(dbQueries(pool), afterFirst, 'second call within 60 s must be served from the cache');
      assert.deepEqual(b.json, a.json);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (d) pool errors
// ---------------------------------------------------------------------------
describe('/api/dashboard: pool error (d)', () => {
  // Distinctive values that must never reach a log line.
  const SENTINELS = ['76543.21', '65432.1', '54321.9', '43210.7', '32109.8', '21098.6', '1999-12-31'];
  const rows = {
    weights: [{ day: '1999-12-31', weight_kg: 76543.21 }],
    nutrition: [
      {
        day: '1999-12-31',
        calories: 65432.1,
        protein_g: 54321.9,
        carbs_g: 21098.6,
        fat_g: 1,
        goal_calories: 32109.8,
        goal_protein_g: 1,
        logged_complete: true,
      },
    ],
    goals: [
      { effective_from: '1999-12-31', target_weight_kg: 1, base_calories: 32109.8, cycling_kj_factor: 1, protein_g: 1 },
    ],
    rides: [{ day: '1999-12-31', kj: 43210.7 }],
    ftp: [{ effective_from: '1999-12-31', ftp_watts: 21098.6 }],
  };

  const cases = [
    ['a source query fails (statement timeout)', ['ftp'], Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['the today query fails (connection refused)', ['today'], Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })],
    ['every query fails', ['today', 'weights', 'goals', 'nutrition', 'ftp', 'rides', 'other'], Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' })],
  ];

  for (const [name, failOn, error] of cases) {
    test(`${name} -> 503 {"error":"unavailable"}; logs hold no row values`, async () => {
      const pool = makeFakePool({ rows, failOn, error });
      const srv = await serve({ pool });
      try {
        const r = await get(srv.base, '/api/dashboard?range=30');
        assert.equal(r.status, 503, r.text);
        assert.deepEqual(r.json, { error: 'unavailable' });
        assert.ok(srv.logs.length > 0, 'expected at least the access log line');
        const all = srv.logs.join('\n');
        for (const s of SENTINELS) assert.ok(!all.includes(s), `log leaks row value ${s}:\n${all}`);
        assert.ok(!all.includes(TOKEN), 'log leaks the bearer token');
      } finally {
        await srv.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// (e) today comes from the database clock in America/Los_Angeles
// ---------------------------------------------------------------------------
describe('/api/dashboard: today (e)', () => {
  test("today = SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date, not the app clock", async () => {
    // The app clock says 2026-10-26; the database says 2026-10-20.
    const pool = makeFakePool({ today: '2026-10-20' });
    const srv = await serve({ pool, now: () => new Date('2026-10-26T12:00:00Z') });
    try {
      const r = await get(srv.base, '/api/dashboard?range=7');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.today, '2026-10-20');
      assert.equal(r.json.nutrition.days.at(-1).day, '2026-10-20');
      assert.equal(r.json.nutrition.days[0].day, '2026-10-14');
      const todayQueries = pool.calls.filter((c) =>
        /\(\s*now\s*\(\s*\)\s+at\s+time\s+zone\s+'america\/los_angeles'\s*\)\s*::\s*date/i.test(c.text)
      );
      assert.ok(
        todayQueries.length >= 1,
        `no query computes (now() AT TIME ZONE 'America/Los_Angeles')::date; saw: ${pool.calls.map((c) => c.text).join(' | ')}`
      );
    } finally {
      await srv.close();
    }
  });
});
