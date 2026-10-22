// Run with: node --test cloudflare-worker/test/
// Uses Node 22 global Request/Response and a Map-backed fake KV namespace.
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const TOKEN = "test-token";
const BASE = "https://health.example.test";

// Fake KV: get/put/list with prefix + cursor pagination (pageSize keys per page).
function makeKV(pageSize = 1000) {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key).value : null;
    },
    async put(key, value, options = {}) {
      store.set(key, { value, options });
    },
    async list({ prefix = "", cursor } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = names.slice(start, start + pageSize);
      const end = start + slice.length;
      const list_complete = end >= names.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete,
        cursor: list_complete ? undefined : String(end),
      };
    },
  };
}

function makeEnv(kv = makeKV()) {
  return { HEALTH_TOKEN: TOKEN, NUTRITION_STORE: kv };
}

function req(path, { method = "GET", body, token = TOKEN, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h["X-Health-Token"] = token;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Synthetic values only.
const BODY_PAYLOAD = {
  data: {
    metrics: [
      {
        name: "weight_body_mass",
        units: "lb",
        data: [{ date: "2026-10-20 07:00:00 -0700", qty: 170.0, source: "Synthetic Scale" }],
      },
      {
        name: "body_fat_percentage",
        units: "%",
        data: [{ date: "2026-10-20 07:00:00 -0700", qty: 20.0, source: "Synthetic Scale" }],
      },
      { name: "lean_body_mass", units: "lb", data: [] },
    ],
  },
};

test("returns 401 without a token", async () => {
  const env = makeEnv();
  for (const [path, method] of [
    ["/health/body", "GET"],
    ["/health/body", "POST"],
    ["/health", "POST"],
  ]) {
    const res = await worker.fetch(req(path, { method, token: null, body: method === "POST" ? BODY_PAYLOAD : undefined }), env);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.equal(env.NUTRITION_STORE.store.size, 0);
});

test("POST /health/body stores the payload and GET returns it", async () => {
  const env = makeEnv();
  const post = await worker.fetch(req("/health/body", { method: "POST", body: BODY_PAYLOAD }), env);
  assert.equal(post.status, 200);
  const postJson = await post.json();
  assert.equal(postJson.status, "ok");
  assert.equal(postJson.stored, 2); // empty lean_body_mass series dropped
  assert.match(postJson.key, /^body:\d{4}-\d{2}-\d{2}T.*:[0-9a-f]{8}$/);

  const stored = env.NUTRITION_STORE.store.get(postJson.key);
  assert.ok(stored, "value written to KV");
  assert.equal(stored.options.expirationTtl, 30 * 24 * 60 * 60);

  const get = await worker.fetch(req("/health/body"), env);
  assert.equal(get.status, 200);
  const { payloads } = await get.json();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].key, postJson.key);
  assert.ok(payloads[0].received_at);
  assert.deepEqual(
    payloads[0].metrics.map((m) => m.name),
    ["weight_body_mass", "body_fat_percentage"]
  );
  assert.equal(payloads[0].metrics[0].data[0].qty, 170.0);
});

test("POST /health/body accepts a bare { metrics } body", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    req("/health/body", { method: "POST", body: { metrics: BODY_PAYLOAD.data.metrics } }),
    env
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stored, 2);
});

test("GET /health/body applies the since filter across list pages, sorted by key", async () => {
  const kv = makeKV(2); // force cursor pagination
  const env = makeEnv(kv);
  const keys = [
    "body:2026-09-01T10:00:00.000Z:aaaaaaaa",
    "body:2026-10-01T10:00:00.000Z:bbbbbbbb",
    "body:2026-10-15T10:00:00.000Z:cccccccc",
    "body:2026-10-15T09:00:00.000Z:dddddddd",
    "body:2026-10-21T10:00:00.000Z:eeeeeeee",
  ];
  for (const k of keys) {
    const received_at = k.slice(5, 29);
    await kv.put(k, JSON.stringify({ received_at, metrics: [] }));
  }
  await kv.put("nutrition:2026-10-15", JSON.stringify({ date: "2026-10-15" }));

  const res = await worker.fetch(req("/health/body?since=2026-10-15"), env);
  assert.equal(res.status, 200);
  const { payloads } = await res.json();
  assert.deepEqual(payloads.map((p) => p.key), [
    "body:2026-10-15T09:00:00.000Z:dddddddd",
    "body:2026-10-15T10:00:00.000Z:cccccccc",
    "body:2026-10-21T10:00:00.000Z:eeeeeeee",
  ]);
  assert.equal(payloads[0].received_at, "2026-10-15T09:00:00.000Z");

  const none = await worker.fetch(req("/health/body?since=2030-01-01"), env);
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), { payloads: [] });
});

test("GET /health/body rejects a malformed since", async () => {
  const res = await worker.fetch(req("/health/body?since=yesterday"), makeEnv());
  assert.equal(res.status, 400);
});

test("POST /health/body with only empty series stores nothing", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    req("/health/body", {
      method: "POST",
      body: { data: { metrics: [{ name: "weight_body_mass", units: "lb", data: [] }, { name: "bmi" }] } },
    }),
    env
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", stored: 0 });
  assert.equal(env.NUTRITION_STORE.store.size, 0);
});

test("POST /health/body without metrics returns 400 missing metrics", async () => {
  const res = await worker.fetch(req("/health/body", { method: "POST", body: { data: {} } }), makeEnv());
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "missing metrics" });
});

test("POST /health/body over 20 MB returns 413", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    req("/health/body", {
      method: "POST",
      body: BODY_PAYLOAD,
      headers: { "Content-Length": String(21 * 1024 * 1024) },
    }),
    env
  );
  assert.equal(res.status, 413);
  assert.equal(env.NUTRITION_STORE.store.size, 0);
});

test("existing POST /health still returns { status, date }", async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    req("/health", {
      method: "POST",
      body: {
        data: {
          metrics: [
            { name: "dietary_energy", units: "kcal", data: [{ date: "2026-10-20 00:00:00 -0700", qty: 2000 }] },
            { name: "protein", units: "g", data: [{ date: "2026-10-20 00:00:00 -0700", qty: 150 }] },
          ],
        },
      },
    }),
    env
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", date: "2026-10-20" });
  const rec = JSON.parse(env.NUTRITION_STORE.store.get("nutrition:2026-10-20").value);
  assert.equal(rec.calories, 2000);
  assert.equal(rec.protein_g, 150);

  // GET /health is still 405 and an unknown path is still 404
  assert.equal((await worker.fetch(req("/health"), env)).status, 405);
  assert.equal((await worker.fetch(req("/health/nope"), env)).status, 404);
});
