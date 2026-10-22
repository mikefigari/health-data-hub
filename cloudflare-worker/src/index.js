var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var NUTRITION_METRICS = {
  // Apple Health internal identifiers
  dietary_energy_consumed: "calories",
  dietary_protein:         "protein_g",
  dietary_carbohydrates:   "carbs_g",
  dietary_fat_total:       "fat_g",
  dietary_fiber:           "fiber_g",
  // Health Auto Export display names (normalised to lowercase + underscores)
  dietary_energy:          "calories",
  active_energy:           "calories",
  energy:                  "calories",
  protein:                 "protein_g",
  carbohydrates:           "carbs_g",
  total_fat:               "fat_g",
  fiber:                   "fiber_g",
};
var TTL_SECONDS = 30 * 24 * 60 * 60;

function parseDate(dateStr) {
  return dateStr.slice(0, 10);
}
__name(parseDate, "parseDate");

function normaliseName(raw) {
  return (raw || "").toLowerCase().replace(/[\s\-]+/g, "_");
}
__name(normaliseName, "normaliseName");

function unauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" }
  });
}
__name(unauthorized, "unauthorized");

function checkAuth(request, env) {
  const token = request.headers.get("X-Health-Token");
  return token && token === env.HEALTH_TOKEN;
}
__name(checkAuth, "checkAuth");

async function handlePost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Accept both { data: { metrics: [...] } } and { metrics: [...] }
  const metrics = body?.data?.metrics ?? body?.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return new Response(JSON.stringify({ error: "missing metrics" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const values = {};
  let date = null;

  for (const metric of metrics) {
    const entries = metric.data;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const entry = entries[0];

    // Extract date from ANY metric that has a data point — not just nutrition ones
    if (!date) {
      const rawDate = entry.date || entry.startDate;
      if (rawDate) date = parseDate(String(rawDate));
    }

    // Extract nutrition value if this metric is recognised
    const field = NUTRITION_METRICS[normaliseName(metric.name)];
    if (field && entry.qty != null) {
      values[field] = entry.qty;
    }
  }

  if (!date) {
    return new Response(JSON.stringify({ error: "could not extract date from metrics" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const record = {
    date,
    calories:    values.calories   ?? null,
    protein_g:   values.protein_g  ?? null,
    carbs_g:     values.carbs_g    ?? null,
    fat_g:       values.fat_g      ?? null,
    fiber_g:     values.fiber_g    ?? null,
    received_at: new Date().toISOString(),
    source:      "apple_health"
  };

  await env.NUTRITION_STORE.put(
    `nutrition:${date}`,
    JSON.stringify(record),
    { expirationTtl: TTL_SECONDS }
  );

  return new Response(JSON.stringify({ status: "ok", date }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
__name(handlePost, "handlePost");

async function handleGetByDate(date, env) {
  const raw = await env.NUTRITION_STORE.get(`nutrition:${date}`);
  if (!raw) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
  return new Response(raw, {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
__name(handleGetByDate, "handleGetByDate");

async function handleGetLatest(env) {
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const raw = await env.NUTRITION_STORE.get(`nutrition:${dateStr}`);
    if (raw) {
      return new Response(raw, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" }
  });
}
__name(handleGetLatest, "handleGetLatest");

// ---------------------------------------------------------------------------
// Body measurement routes (Renpho -> Apple Health -> Health Auto Export)
// Payloads are stored raw; all parsing happens in Python on the Pi.
// ---------------------------------------------------------------------------

var BODY_PREFIX = "body:";
var BODY_MAX_BYTES = 20 * 1024 * 1024;
var BODY_DEFAULT_LOOKBACK_DAYS = 10;

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
__name(jsonResponse, "jsonResponse");

async function handleBodyPost(request, env) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > BODY_MAX_BYTES) {
    return jsonResponse({ error: "payload too large" }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid json" }, 400);
  }

  // Accept both { data: { metrics: [...] } } and { metrics: [...] }
  const metrics = body?.data?.metrics ?? body?.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return jsonResponse({ error: "missing metrics" }, 400);
  }

  const kept = metrics.filter((m) => Array.isArray(m?.data) && m.data.length > 0);
  if (kept.length === 0) {
    return jsonResponse({ status: "ok", stored: 0 }, 200);
  }

  const received_at = new Date().toISOString();
  const key = `${BODY_PREFIX}${received_at}:${crypto.randomUUID().slice(0, 8)}`;
  await env.NUTRITION_STORE.put(
    key,
    JSON.stringify({ received_at, metrics: kept }),
    { expirationTtl: TTL_SECONDS }
  );

  return jsonResponse({ status: "ok", stored: kept.length, key }, 200);
}
__name(handleBodyPost, "handleBodyPost");

async function handleBodyGet(url, env) {
  let since = url.searchParams.get("since");
  if (since === null || since === "") {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - BODY_DEFAULT_LOOKBACK_DAYS);
    since = d.toISOString().slice(0, 10);
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return jsonResponse({ error: "invalid since, expected YYYY-MM-DD" }, 400);
  }

  const lowerBound = `${BODY_PREFIX}${since}`;
  const names = [];
  let cursor;
  let page;
  do {
    page = await env.NUTRITION_STORE.list({ prefix: BODY_PREFIX, cursor });
    for (const k of page.keys) {
      if (k.name >= lowerBound) names.push(k.name);
    }
    cursor = page.cursor;
  } while (!page.list_complete);

  names.sort();
  const payloads = [];
  for (const name of names) {
    const raw = await env.NUTRITION_STORE.get(name);
    if (!raw) continue; // expired between list and get
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    payloads.push({ key: name, received_at: value.received_at, metrics: value.metrics });
  }

  return jsonResponse({ payloads }, 200);
}
__name(handleBodyGet, "handleBodyGet");

// ---------------------------------------------------------------------------
// Strava webhook routes
// These are unauthenticated — Strava manages its own auth via verify_token.
// ---------------------------------------------------------------------------

async function handleStravaWebhookGet(url, env) {
  // Strava calls GET /strava/webhook?hub.mode=subscribe&hub.challenge=...&hub.verify_token=...
  // to validate the subscription. Echo the challenge if the verify_token matches.
  const mode      = url.searchParams.get("hub.mode");
  const challenge = url.searchParams.get("hub.challenge");
  const token     = url.searchParams.get("hub.verify_token");

  if (mode === "subscribe" && challenge && token === env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    return new Response(JSON.stringify({ "hub.challenge": challenge }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
__name(handleStravaWebhookGet, "handleStravaWebhookGet");

async function handleStravaWebhookPost(request, env, ctx) {
  // Strava POSTs activity events here. Forward to the Pi's local webhook
  // receiver (reachable via a cloudflared tunnel or port-forward configured
  // as PI_WEBHOOK_URL in Worker secrets), then immediately return 200 so
  // Strava does not retry. Processing happens asynchronously on the Pi.
  const body = await request.text();

  if (env.PI_WEBHOOK_URL) {
    ctx.waitUntil(
      fetch(env.PI_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }).catch((err) => console.error("Strava webhook forward failed:", String(err)))
    );
  }

  return new Response("OK", { status: 200 });
}
__name(handleStravaWebhookPost, "handleStravaWebhookPost");

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    // Strava webhook — must come before checkAuth (Strava doesn't send X-Health-Token)
    if (path === "/strava/webhook") {
      if (request.method === "GET")  return handleStravaWebhookGet(url, env);
      if (request.method === "POST") return handleStravaWebhookPost(request, env, ctx);
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: "GET, POST" },
      });
    }

    if (!checkAuth(request, env)) {
      return unauthorized();
    }
    if (request.method === "POST" && path === "/health") {
      return handlePost(request, env);
    }
    if (request.method === "GET" && path === "/health/latest") {
      return handleGetLatest(env);
    }
    if (request.method === "POST" && path === "/health/body") {
      return handleBodyPost(request, env);
    }
    if (request.method === "GET" && path === "/health/body") {
      return handleBodyGet(url, env);
    }
    const dateMatch = path.match(/^\/health\/(\d{4}-\d{2}-\d{2})$/);
    if (request.method === "GET" && dateMatch) {
      return handleGetByDate(dateMatch[1], env);
    }
    if (path === "/health" && request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: "POST" }
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
};
export { index_default as default };
