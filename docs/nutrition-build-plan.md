# Nutrition logging via Claude: build plan

Status: draft for review, 2026-10-25. No implementation yet.
Scope: `food_log`, `my_foods`, USDA reference data, MCP write tools on
`health-mcp`, migration of `nutrition_daily`, and an optional voice-note feed.

---

## 0. Summary

You tell Claude what you ate, in text or with a photo, in any Claude session.
Claude does the estimating. The server stores structured items, checks favorites
and USDA data first, and keeps every estimate labeled with a confidence level
and a source.

The recommended shape:

- **Same connector, new tools.** Six nutrition tools go into the existing
  `health-mcp` server. Writes use a second connection pool under a new
  least-privilege role, `nutrition_writer`. The `query` tool keeps its own pool
  under `claude_readonly`, so the read-only guarantee is unchanged.
- **`food_log` rows are self-contained.** Each row stores its own computed
  nutrients. Changing a favorite or reloading USDA data never rewrites history.
- **`nutrition_daily` becomes a view.** The current table is renamed to
  `nutrition_daily_legacy` and frozen. A view with the same name, columns and
  types returns `food_log` totals for any day that has entries, and the legacy
  row otherwise. Every current reader keeps working unchanged.
- **USDA Foundation + SR Legacy only, to start.** About 8,000 foods, roughly
  100–150 MB on the Pi, loaded in under a minute. Branded is deferred (GB-scale
  and multi-hour on a Pi, for little gain over favorites). Open Food Facts is
  skipped. FNDDS (USDA "as eaten" mixed dishes) is suggested as a cheap,
  high-value optional addition.
- **Delivery:** Phase 0 (safety and test harness), Phase 1 MVP (log_food end to
  end), Phase 2 (corrections and the `nutrition_daily` view), Phase 3 (USDA),
  Phase 4 (optional extras), Phase 5 (voice notes).

**Decisions that need your sign-off before the task that applies them runs**
(details in §12):

1. Rename `nutrition_daily` to a table plus view (T2.3).
2. Retire, or redirect, the Apple Health nutrition poller that still writes to
   `nutrition_daily` every night (T2.4).
3. Give the existing claude.ai connector write access (T1.2). Every OAuth token
   and the static API key would then be able to write.

---

## 1. What is actually in the repo and the database

I checked the repo and the live `health_pi` database (via the read-only MCP
`query` tool) on 2026-10-25. Where this differs from the brief or the docs, the
difference is listed below.

### 1.1 Matches the brief

- `health-mcp/` is a Node.js server built on Express, `@modelcontextprotocol/sdk`
  ^1.30, `pg` and `zod`. It uses the stateless Streamable HTTP transport and
  exposes exactly `list_tables`, `describe_table` and `query`
  ([server.mjs](../health-mcp/server.mjs)).
- OAuth 2.1 with DCR, PKCE S256, RFC 9728/8414 metadata, and a redirect-URI
  allowlist live in [oauth.mjs](../health-mcp/oauth.mjs). It serves a single
  identity: the consent password is `MCP_API_KEY`.
- The server binds `127.0.0.1:8877` behind Cloudflare Tunnel, runs under systemd
  as user `mike`, and keeps its secrets in `~/.config/health-mcp/health-mcp.env`
  (mode 600). There is no Docker anywhere.
- Postgres **18.3** on aarch64. `health_pi` is 197 MB, 171 MB of which is
  `workout_samples`. Server `TimeZone` is already `America/Los_Angeles`.
- `nutrition_daily` has 55 rows: 21 `myfitnesspal` (2025-12-20 → 2026-03-16) and
  34 `apple_health` (2026-03-23 → 2026-10-22). Columns match the brief.

### 1.2 Conflicts and surprises

| # | Finding | Impact on the plan |
|---|---|---|
| C1 | **A writer still exists.** `scheduler_all.py` runs `nutrition_poller.poll_once` every night at 22:00. It upserts into `nutrition_daily` through [insert_nutrition_daily.py](../health_data_hub/etl/load/insert_nutrition_daily.py). | If `nutrition_daily` becomes a view, that INSERT fails. The poller has to be retired or pointed at the legacy table in the same release (T2.4). |
| C2 | **13 of the 34 `apple_health` rows are all NULL.** The poller keeps re-upserting the Worker's "latest" day with no values. The last day with real data is 2026-10-09. Because `ON CONFLICT … SET calories = EXCLUDED.calories` overwrites, a late empty payload could also wipe a good day. | Supports retiring the poller. A trigger-maintained `nutrition_daily` would be clobbered nightly by this same upsert, which is another reason to prefer a view. |
| C3 | The `health-mcp` README says nutrition is "Cronometer-sourced". The actual sources are MFP and Apple Health. Row counts in the README are also stale. | Documentation fix only (T2.6). |
| C4 | **`pg_trgm`, `unaccent`, `fuzzystrmatch` and `btree_gin` are available but not installed.** | The first migration runs `CREATE EXTENSION pg_trgm` as `postgres`. |
| C5 | **There is no migration framework.** [schema.sql](../health_data_hub/db/schema.sql) is an idempotent "create if not exists" file run by `init_db.py`. There is one hand-applied file in `db/migrations/`. | A tiny migration ledger is added (T0.3). `schema.sql` must be kept in step. Its line `ALTER TABLE nutrition_daily ADD COLUMN IF NOT EXISTS weight_kg` **errors once `nutrition_daily` is a view**, so it changes in the same task (T2.3). |
| C6 | `list_tables` only lists relkind `r` and `v` in `public`. It does not list materialized views or other schemas. | USDA search data goes in a plain table in `public` (`usda_food`). Raw USDA tables go in schema `usda`. |
| C7 | `health-mcp` has no tests, and CI ([kit-ci.yml](../.github/workflows/kit-ci.yml)) only runs Python pytest. | Phase 0 adds `node --test` and a CI job. |
| C8 | Python tests use a FakeConn and never touch a real database. Nothing tests SQL against Postgres today. | DDL, views and roles need integration tests against a real Postgres 18 (T0.2). |
| C9 | Voice notes live in **separate databases** (`voice_notes`, `voice_notes_dev`) with their own MCP server. [n8n-health-coach-discovery.md](../n8n-health-coach-discovery.md) sets the guardrail "health_pi is read-only from n8n unless I say otherwise". | Phase 5 recommends that Claude process food voice notes through both MCP servers. n8n writing directly to `health_pi` would need you to lift that guardrail. |
| C10 | `PUBLIC` has CONNECT+TEMP on `health_pi`, and default CONNECT on the `n8n` database. The README's claim "no CONNECT on any other database" is not true for `n8n`. `claude_readonly` has no table grants there, so the risk is low. | Hardening task T4.5 (optional). |
| C11 | MFP goals in the legacy rows change daily (2300–3439 kcal) and the macros are a fixed 30/40/30 split. That pattern is MFP's "base + exercise calories". | `nutrition_goals` supports a base goal plus an optional exercise adjustment. Open question Q5. |
| C12 | The OAuth consent page says "requesting **read-only** access". Refresh tokens never expire and are stored in plain text in `oauth-state.json`. | The consent text must change when writes ship (T1.2). Refresh-token expiry and hashing go into optional hardening (T4.4). |
| C13 | The `query` guard's keyword regex also matches keywords inside string literals. Exploring, I had a SELECT rejected because it contained the text `'CREATE'`. | Harmless, and left unchanged on purpose. Noted so nobody "fixes" it by loosening the guard. |
| C14 | Latent Worker bug: [index.js](../cloudflare-worker/src/index.js) maps the Apple Health metrics `active_energy` and `energy` to **calories eaten**. I spot-checked the stored rows: 4P+4C+9F matches calories within about 1%, so no burned calories have leaked in yet. | Becomes moot if the poller is retired. Fix it if you keep the feed (T2.4). |
| C15 | `kit.json` marks `db/`, `migrations/` and `oauth*` as protected paths. | Tasks that touch them (T0.3, T1.1, T1.2's consent text, T2.3, T3.1) are tagged **[protected]**. Under the kit pipeline they need your approval, or you apply them yourself. |
| C16 | `pi/README.md` names the service `health-hub.service`. The repo's unit file is `health-data-hub.service`. | Deploy steps in this plan use `health-mcp.service`, which is unaffected. Worth checking on the Pi. |

---

## 2. Architecture

```
 Any Claude session (claude.ai web/mobile, desktop, Claude Code)
   │  Claude does the estimating: parses text, looks at the photo, picks
   │  portions, calls search_foods, then log_food with structured items
   ▼
 https://health-mcp.michaelfigari.com/mcp   (Cloudflare Tunnel → 127.0.0.1:8877)
   │  mcpAuth: OAuth token or static key  →  req.auth = { clientId }
   ▼
 health-mcp (Node)
   ├─ read tools ── list_tables, describe_table, query      ┐ pool A
   │               search_foods, get_day_summary           ┘ role claude_readonly
   │                                                          (read-only txn)
   └─ write tools ─ log_food, save_favorite,               ┐ pool B
                    update_log_entry, delete_log_entry,    ┘ role nutrition_writer
                    (P2) mark_day_complete                    INSERT/UPDATE on 5 tables,
                    guarded by WRITE_TOOLS_ENABLED,           no DELETE on food_log,
                    rate limit, zod bounds                    nothing else
   ▼
 Postgres health_pi
   public.food_log ──────────┐            public.my_foods + my_food_aliases
   public.food_log_audit     │            public.nutrition_goals, nutrition_day_status
   public.usda_food (flat,   │            usda.* (raw FDC tables, refreshed by import)
     trigram + FTS indexed)  ▼
   VIEW public.nutrition_daily  =  food_log totals per LA day
                                   ∪ nutrition_daily_legacy rows for days without food_log
   (existing readers: export_daily_json, notion-reporter, nutrition_reader,
    quality checks, ad-hoc query tool: all unchanged)
```

---

## 3. Key decisions and tradeoffs

### D1. `nutrition_daily` migration: view over legacy + `food_log` (recommended)

| Option | Pros | Cons |
|---|---|---|
| **A. View** (rename the table to `nutrition_daily_legacy` and create view `nutrition_daily`) | Always consistent with `food_log`, so drift is impossible. Zero maintenance. Edits and deletes show up instantly. Old rows are kept byte-for-byte. Cheap at this scale (hundreds of rows per year). | The nightly poller's INSERT breaks (C1). It must be retired or retargeted in the same release. `schema.sql` needs the same change (C5). `list_tables` will show the kind as "view". |
| B. Trigger-maintained table | Writers and readers keep working without changes. | Two sources of truth. A recompute job is needed after bugs. The nightly Apple Health upsert would overwrite `food_log` totals with NULLs (C2). Harder to reason about with edits and soft deletes. |
| C. Materialized view | Fast reads. | Stale until refreshed, needs a refresh hook on every write, and is not listed by `list_tables` (C6). |
| D. UNION done in each reader | No schema change. | Breaks "existing queries keep working". Every reader, including ad-hoc Claude queries, has to know about it. |

**Recommendation: A.** Precedence is per day. If a day has any non-deleted
`food_log` rows, the view returns their totals with `source = 'food_log'`.
Otherwise it returns the legacy row. Days are never summed across the two
sources, which rules out double counting during the switch-over.

The view keeps the exact column order and types of the original table
(`calories int`, `*_g double precision`, `weight_kg numeric(5,2)`, and so on).
That way `json_build_object` output and psycopg2/pg types in
`export_daily_json.py`, `notion-reporter/src/utils/db.mjs` and
`nutrition_reader.py` do not change.

`weight_kg` is NULL in every legacy row, and readers already use
`COALESCE(bw.weight_kg, nu.weight_kg)` from `body_weight_daily`. The view
therefore returns NULL `weight_kg` for `food_log` days.

### D2. USDA data: Foundation + SR Legacy into `usda.*`, flattened into `public.usda_food`

- Raw, normalized FDC tables live in schema `usda`: `food`, `nutrient`,
  `food_nutrient`, `food_portion`, `release`. They keep every nutrient, so
  potassium, saturated fat or caffeine can be added later without re-importing.
- `public.usda_food` holds one row per food. It has per-100 g values for the 7
  tracked nutrients and a JSONB list of portions (`[{label:"1 cup, chopped",
  grams:128}]`), and carries the trigram and full-text indexes. It is a plain
  table, not a materialized view, so `list_tables` shows it (C6). The importer
  rebuilds it.
- FDC assigns **new `fdc_id`s** when Foundation foods are revised. Old foods are
  therefore flagged `is_current = false` rather than deleted, and `food_log` and
  `my_foods` refer to USDA by a soft `fdc_id` with no FK (see D3).
- Branded is deferred (§7.4). Open Food Facts is skipped (§7.5). FNDDS is
  optional (§7.6).

### D3. `food_log` rows store their own nutrients; references are soft or hard as appropriate

- Each row stores calories and macros as logged. A favorite's values can change
  and USDA can be reloaded, and past days stay the same.
- `my_food_id` is a real FK with `ON DELETE RESTRICT`. Favorites are archived,
  never deleted, so the restriction protects history.
- `fdc_id` is a soft reference with no FK, because of the fdc_id churn in D2.
- `ref_label` is free text for restaurant items ("Chipotle chicken bowl, chipotle.com
  nutrition calculator").
- CHECK constraints enforce that `match_source='favorite'` implies `my_food_id`
  is set, and `match_source='usda'` implies `fdc_id` is set.

### D4. Write tools in the same server and connector, with a separate pool and role

| Option | Pros | Cons |
|---|---|---|
| **Same `/mcp` endpoint** | One connector, so it works in every Claude session with no extra setup. Read and write tools can see each other. | Every token can write (C12). |
| Separate `/mcp-food` endpoint or a second connector | Write access can be enabled per session. | Two connectors to add on every client. The model loses `query` context unless both are enabled. claude.ai cannot pick OAuth scopes per connector anyway. |

**Recommendation: same endpoint.** Blast-radius controls:

- the DB role (no DELETE on `food_log`, no access to other tables)
- soft delete plus an audit trail
- a `WRITE_TOOLS_ENABLED` kill switch
- a rate limit
- bounded inputs

All read tools, including the new `search_foods` and `get_day_summary`, use
pool A (`claude_readonly`). Only the four write tools touch pool B.

### D5. Soft delete plus an audit table

`delete_log_entry` sets `deleted_at`. `nutrition_writer` has no DELETE on
`food_log`. An AFTER trigger writes every insert, update, soft delete and
restore to `food_log_audit` as JSONB. Any bad write by a model, including one
caused by prompt injection, is reversible.

### D6. Server-side nutrient computation from references (optional per item)

If an item gives `my_food_id` + `servings`, or `fdc_id` + `grams`, and leaves the
nutrients out, the server computes them. This removes arithmetic errors by the
model. If the model does send nutrients, for example because it adjusted for
"extra butter", its values win. The server returns a warning when they differ
from the reference by more than 30%.

The server also runs an Atwater sanity check: it warns when
`|4P + 4C + 9F − kcal|` exceeds `max(60 kcal, 25%)`. This is a warning, not an
error, because alcohol and fiber legitimately cause gaps.

In Phase 1, computation only covers favorites. USDA computation arrives with
Phase 3.

### D7. Day boundary is a stored generated column

`day date GENERATED ALWAYS AS ((eaten_at AT TIME ZONE 'America/Los_Angeles')::date) STORED`.

`timezone(text, timestamptz)` with a constant zone is immutable, which T1.1
verifies. Day assignment then never depends on the session `TimeZone`. It stays
correct across DST, and a test on 2026-11-01 (DST ends) covers that. Travel days
still count in LA time (Q13).

Input handling: `eaten_at` with an offset is taken as-is. Without an offset it
is read as LA local time. With `day` + `meal` only, the server picks a default
LA time: breakfast 08:00, lunch 12:30, snack 15:30, dinner 19:00. With nothing,
it uses now.

### D8. Food matching: `pg_trgm` word similarity + English full-text search, no `unaccent`

USDA descriptions are comma-inverted ("Oats, whole grain, rolled, old
fashioned"), so plain `similarity()` scores them poorly. `word_similarity`
(`<%`) matches a short query against the best-matching part of a long
description. FTS (`websearch_to_tsquery`) handles stemming ("eggs" → "egg").

The score is `0.6·trigram + 0.4·min(ts_rank_cd, 1)`, plus small preferences for
Foundation over SR Legacy and for shorter descriptions. The weights are tuned
against a golden query set (T3.4).

`unaccent` is skipped. It is STABLE and needs an immutable wrapper to be
indexed, and food names here are effectively ASCII.

For favorites, exact alias hits (after normalization) always rank first, then
trigram matches. The query normalizer also tries a version with filler words
stripped ("my", "usual", "regular", "the", "normal"), so "my usual oatmeal"
matches an alias "usual oatmeal" or "oatmeal".

### D9. Migration mechanics

- Use numbered SQL files in `health_data_hub/db/migrations/`. Each has a
  matching `.down.sql` and is applied with `psql -v ON_ERROR_STOP=1
  --single-transaction` as `postgres`.
- A ledger table, `public.schema_migrations(name, applied_at)`, and a small
  `scripts/migrate.sh` refuse to re-apply a migration.
- `schema.sql` is updated in the same task, so a fresh `init_db` produces the
  same end state.
- The role password is never in a file. It is set by hand afterwards, following
  the README's rotation recipe.

### D10. Testing approach

- Node: `node --test` (built in, no new dependency).
- Unit tests use a fake `pg` pool.
- Integration tests run against a real Postgres 18 database named by
  `TEST_DATABASE_URL`: your local Windows Postgres, or a `postgres:18` service
  container in CI. They are skipped when the variable is unset.

---

## 4. DDL

The SQL below is the content of the migrations. Comments mark which migration
each block belongs to.

### 4.1 Migration `2026-11_00_migration_ledger.sql` (T0.3)

```sql
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.schema_migrations (name) VALUES ('2026-10_body_measurements')
ON CONFLICT DO NOTHING;   -- record the one already-applied migration
```

### 4.2 Migration `2026-11_01_food_log.sql` (T1.1)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Shared trigger fn: bump updated_at on UPDATE
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- ------------------------------------------------------------
-- Favorites / recurring foods
-- ------------------------------------------------------------
CREATE TABLE public.my_foods (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    serving_qty    NUMERIC(8,2) NOT NULL DEFAULT 1 CHECK (serving_qty > 0),
    serving_unit   TEXT NOT NULL DEFAULT 'serving' CHECK (length(serving_unit) <= 40),
    serving_grams  NUMERIC(7,1) CHECK (serving_grams > 0 AND serving_grams <= 5000),
    -- nutrients for ONE serving as defined above
    calories       NUMERIC(7,1) NOT NULL CHECK (calories  BETWEEN 0 AND 5000),
    protein_g      NUMERIC(6,1) NOT NULL CHECK (protein_g BETWEEN 0 AND 500),
    carbs_g        NUMERIC(6,1) NOT NULL CHECK (carbs_g   BETWEEN 0 AND 1000),
    fat_g          NUMERIC(6,1) NOT NULL CHECK (fat_g     BETWEEN 0 AND 500),
    fiber_g        NUMERIC(6,1) CHECK (fiber_g   BETWEEN 0 AND 200),
    sugar_g        NUMERIC(6,1) CHECK (sugar_g   BETWEEN 0 AND 1000),
    sodium_mg      NUMERIC(7,1) CHECK (sodium_mg BETWEEN 0 AND 20000),
    confidence     TEXT NOT NULL CHECK (confidence IN ('high','med','low')),
    basis          TEXT NOT NULL CHECK (basis IN ('label','usda','recipe','restaurant','estimate')),
    fdc_id         INTEGER,                       -- soft ref to usda_food (no FK, see D2/D3)
    notes          TEXT CHECK (length(notes) <= 500),
    use_count      INTEGER NOT NULL DEFAULT 0,
    last_used_at   TIMESTAMPTZ,
    archived_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX my_foods_name_active_uq
    ON public.my_foods (lower(name)) WHERE archived_at IS NULL;
CREATE TRIGGER my_foods_touch BEFORE UPDATE ON public.my_foods
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.my_food_aliases (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    my_food_id  BIGINT NOT NULL REFERENCES public.my_foods(id) ON DELETE CASCADE,
    alias       TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 120),
    alias_norm  TEXT GENERATED ALWAYS AS
                (lower(regexp_replace(btrim(alias), '\s+', ' ', 'g'))) STORED,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX my_food_aliases_norm_uq ON public.my_food_aliases (alias_norm);
CREATE INDEX my_food_aliases_trgm ON public.my_food_aliases USING gin (alias_norm gin_trgm_ops);
CREATE INDEX my_food_aliases_food ON public.my_food_aliases (my_food_id);
-- save_favorite always inserts the favorite's name as an alias too.

-- ------------------------------------------------------------
-- One row per item eaten
-- ------------------------------------------------------------
CREATE TABLE public.food_log (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    eaten_at       TIMESTAMPTZ NOT NULL,
    day            DATE GENERATED ALWAYS AS
                   ((eaten_at AT TIME ZONE 'America/Los_Angeles')::date) STORED,
    meal           TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
    description    TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
    quantity       NUMERIC(8,2) CHECK (quantity > 0),
    unit           TEXT CHECK (length(unit) <= 40),
    grams          NUMERIC(7,1) CHECK (grams > 0 AND grams <= 5000),
    calories       NUMERIC(7,1) NOT NULL CHECK (calories  BETWEEN 0 AND 5000),
    protein_g      NUMERIC(6,1) NOT NULL CHECK (protein_g BETWEEN 0 AND 500),
    carbs_g        NUMERIC(6,1) NOT NULL CHECK (carbs_g   BETWEEN 0 AND 1000),
    fat_g          NUMERIC(6,1) NOT NULL CHECK (fat_g     BETWEEN 0 AND 500),
    fiber_g        NUMERIC(6,1) CHECK (fiber_g   BETWEEN 0 AND 200),     -- NULL = unknown, not 0
    sugar_g        NUMERIC(6,1) CHECK (sugar_g   BETWEEN 0 AND 1000),
    sodium_mg      NUMERIC(7,1) CHECK (sodium_mg BETWEEN 0 AND 20000),
    confidence     TEXT NOT NULL CHECK (confidence IN ('high','med','low')),
    match_source   TEXT NOT NULL CHECK (match_source IN ('favorite','usda','restaurant','estimate')),
    my_food_id     BIGINT REFERENCES public.my_foods(id) ON DELETE RESTRICT,
    fdc_id         INTEGER,                       -- soft ref (D3)
    ref_label      TEXT CHECK (length(ref_label) <= 200),
    created_via    TEXT NOT NULL CHECK (created_via IN ('claude_mcp','voice_n8n','manual','import')),
    request_id     UUID,                          -- idempotency key for one log_food call
    request_line   SMALLINT,                      -- item index within that call
    notes          TEXT CHECK (length(notes) <= 500),
    deleted_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT food_log_favorite_ref CHECK (match_source <> 'favorite' OR my_food_id IS NOT NULL),
    CONSTRAINT food_log_usda_ref     CHECK (match_source <> 'usda'     OR fdc_id     IS NOT NULL),
    CONSTRAINT food_log_request_uq   UNIQUE (request_id, request_line)
);
CREATE INDEX food_log_day_live  ON public.food_log (day) WHERE deleted_at IS NULL;
CREATE INDEX food_log_eaten_at  ON public.food_log (eaten_at);
CREATE INDEX food_log_my_food   ON public.food_log (my_food_id) WHERE my_food_id IS NOT NULL;
CREATE TRIGGER food_log_touch BEFORE UPDATE ON public.food_log
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ------------------------------------------------------------
-- Audit trail (every insert/update/soft-delete/restore)
-- ------------------------------------------------------------
CREATE TABLE public.food_log_audit (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    food_log_id  BIGINT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('insert','update','soft_delete','restore')),
    old_row      JSONB,
    new_row      JSONB,
    changed_by   TEXT NOT NULL DEFAULT current_user,
    changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX food_log_audit_entry ON public.food_log_audit (food_log_id, changed_at);

CREATE OR REPLACE FUNCTION public.food_log_audit_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.food_log_audit (food_log_id, action, new_row)
        VALUES (NEW.id, 'insert', to_jsonb(NEW));
    ELSE
        INSERT INTO public.food_log_audit (food_log_id, action, old_row, new_row)
        VALUES (NEW.id,
                CASE WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'soft_delete'
                     WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN 'restore'
                     ELSE 'update' END,
                to_jsonb(OLD), to_jsonb(NEW));
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER food_log_audit_trg AFTER INSERT OR UPDATE ON public.food_log
    FOR EACH ROW EXECUTE FUNCTION public.food_log_audit_fn();

-- ------------------------------------------------------------
-- Convenience view: live per-day totals (used by get_day_summary and D1)
-- ------------------------------------------------------------
CREATE VIEW public.food_log_daily AS
SELECT
    day,
    round(sum(calories))::int                       AS calories,
    sum(protein_g)::double precision                AS protein_g,
    sum(carbs_g)::double precision                  AS carbs_g,
    sum(fat_g)::double precision                    AS fat_g,
    sum(fiber_g)::double precision                  AS fiber_g,     -- NULL only if all items NULL
    sum(sugar_g)::double precision                  AS sugar_g,
    sum(sodium_mg)::double precision                AS sodium_mg,
    count(*)                                        AS items,
    count(*) FILTER (WHERE fiber_g IS NULL OR sugar_g IS NULL OR sodium_mg IS NULL)
                                                    AS items_missing_micros,
    count(*) FILTER (WHERE confidence = 'low')      AS low_confidence_items,
    round(coalesce(sum(calories) FILTER (WHERE confidence = 'low' OR match_source = 'estimate'), 0)
          / nullif(sum(calories), 0), 2)            AS estimated_calorie_share,
    min(created_at)                                 AS created_at,
    max(updated_at)                                 AS updated_at
FROM public.food_log
WHERE deleted_at IS NULL
GROUP BY day;

-- ------------------------------------------------------------
-- Least-privilege writer role (password set out-of-band)
-- ------------------------------------------------------------
CREATE ROLE nutrition_writer LOGIN CONNECTION LIMIT 3;
ALTER ROLE nutrition_writer SET statement_timeout = '5s';
ALTER ROLE nutrition_writer SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE nutrition_writer SET search_path = public;
GRANT CONNECT ON DATABASE health_pi TO nutrition_writer;
GRANT USAGE ON SCHEMA public TO nutrition_writer;

GRANT SELECT, INSERT ON public.food_log TO nutrition_writer;
GRANT UPDATE (eaten_at, meal, description, quantity, unit, grams,
              calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
              confidence, match_source, my_food_id, fdc_id, ref_label, notes, deleted_at)
    ON public.food_log TO nutrition_writer;                 -- no id/created_via/request_* edits
GRANT SELECT, INSERT, UPDATE ON public.my_foods TO nutrition_writer;
GRANT SELECT, INSERT, DELETE ON public.my_food_aliases TO nutrition_writer;
GRANT INSERT ON public.food_log_audit TO nutrition_writer;  -- trigger writes; no SELECT needed
GRANT SELECT ON public.food_log_daily TO nutrition_writer;
-- No DELETE on food_log/my_foods. No access to any other table.
-- claude_readonly gets SELECT on all new public tables/views automatically via the
-- existing ALTER DEFAULT PRIVILEGES (grantor postgres). T1.1 tests that.
```

Notes:
- Identity columns need no separate sequence grant for INSERT. T1.1 verifies
  this.
- `ALTER ROLE ... SET` only affects new sessions, so the pool must be created
  after the migration. That holds anyway, because the server restarts on deploy.

### 4.3 Migration `2026-11_02_nutrition_daily_view.sql` (T2.2 + T2.3, **[protected]**, needs your approval)

```sql
-- Goals: base goal, optionally adjusted by exercise (C11)
CREATE TABLE public.nutrition_goals (
    effective_from    DATE PRIMARY KEY,
    base_calories     INT NOT NULL CHECK (base_calories BETWEEN 800 AND 6000),
    protein_g         NUMERIC(6,1),
    carbs_g           NUMERIC(6,1),
    fat_g             NUMERIC(6,1),
    exercise_adjust   TEXT NOT NULL DEFAULT 'none'
                      CHECK (exercise_adjust IN ('none','oura_active')),
    exercise_factor   NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (exercise_factor BETWEEN 0 AND 1.5),
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Seed row is an OPEN QUESTION (Q5); placeholder = last MFP goal:
-- INSERT INTO nutrition_goals VALUES ('2026-11-01', 2300, 173, 230, 77, 'none', 1.0, 'seed from MFP 2026-03-16');

CREATE TABLE public.nutrition_day_status (
    day              DATE PRIMARY KEY,
    logged_complete  BOOLEAN NOT NULL,
    note             TEXT CHECK (length(note) <= 300),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER nutrition_day_status_touch BEFORE UPDATE ON public.nutrition_day_status
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
GRANT SELECT, INSERT, UPDATE ON public.nutrition_day_status TO nutrition_writer;
GRANT SELECT ON public.nutrition_goals TO nutrition_writer;

-- Freeze the historical table under a new name
ALTER TABLE public.nutrition_daily RENAME TO nutrition_daily_legacy;
ALTER INDEX public.nutrition_daily_pkey RENAME TO nutrition_daily_legacy_pkey;
COMMENT ON TABLE public.nutrition_daily_legacy IS
    'Frozen: MFP (2025-12..2026-03) and Apple Health (2026-03..2026-10) daily totals. '
    'New days come from food_log via VIEW nutrition_daily.';

-- Same name, same columns, same order, same types as the old table
CREATE VIEW public.nutrition_daily AS
WITH meals AS (
    SELECT day,
           jsonb_object_agg(CASE meal WHEN 'snack' THEN 'snacks' ELSE meal END,   -- MFP key shape
                            jsonb_build_object('calories',  round(cal, 1),
                                               'protein_g', round(p, 1),
                                               'carbs_g',   round(c, 1),
                                               'fat_g',     round(f, 1))) AS meals_json
    FROM (SELECT day, meal, sum(calories) cal, sum(protein_g) p, sum(carbs_g) c, sum(fat_g) f
          FROM public.food_log WHERE deleted_at IS NULL
          GROUP BY day, meal) m
    GROUP BY day
)
SELECT
    fl.day,
    fl.calories,
    fl.protein_g, fl.carbs_g, fl.fat_g, fl.fiber_g, fl.sugar_g, fl.sodium_mg,
    (g.base_calories
       + CASE WHEN g.exercise_adjust = 'oura_active'
              THEN round(coalesce(oa.cal_active, 0) * g.exercise_factor)::int ELSE 0 END
    )::int                                  AS goal_calories,
    g.protein_g::double precision           AS goal_protein_g,
    g.carbs_g::double precision             AS goal_carbs_g,
    g.fat_g::double precision               AS goal_fat_g,
    m.meals_json,
    'food_log'::text                        AS source,
    s.logged_complete,
    NULL::numeric(5,2)                      AS weight_kg,
    fl.created_at,
    fl.updated_at
FROM public.food_log_daily fl
LEFT JOIN meals m                       ON m.day = fl.day
LEFT JOIN public.nutrition_day_status s ON s.day = fl.day
LEFT JOIN public.oura_activity_raw oa   ON oa.day = fl.day
LEFT JOIN LATERAL (
    SELECT * FROM public.nutrition_goals g
    WHERE g.effective_from <= fl.day
    ORDER BY g.effective_from DESC LIMIT 1
) g ON true
UNION ALL
SELECT l.day, l.calories, l.protein_g, l.carbs_g, l.fat_g, l.fiber_g, l.sugar_g, l.sodium_mg,
       l.goal_calories, l.goal_protein_g, l.goal_carbs_g, l.goal_fat_g,
       l.meals_json, l.source, l.logged_complete, l.weight_kg, l.created_at, l.updated_at
FROM public.nutrition_daily_legacy l
WHERE NOT EXISTS (SELECT 1 FROM public.food_log f
                  WHERE f.day = l.day AND f.deleted_at IS NULL);

GRANT SELECT ON public.nutrition_daily TO nutrition_writer;
```

`schema.sql` changes in the same task:
- The `nutrition_daily` table block becomes `nutrition_daily_legacy`.
- `ALTER TABLE nutrition_daily ADD COLUMN …` becomes
  `ALTER TABLE nutrition_daily_legacy …`.
- The new tables and views from 4.2 and 4.3 are appended after
  `body_weight_daily`, so the view is created after its base tables.

### 4.4 Migration `2026-11_03_usda_reference.sql` (T3.1, **[protected]**)

```sql
CREATE SCHEMA IF NOT EXISTS usda AUTHORIZATION postgres;

CREATE TABLE usda.release (
    id             SERIAL PRIMARY KEY,
    dataset        TEXT NOT NULL CHECK (dataset IN ('foundation','sr_legacy','fndds','branded')),
    release_label  TEXT NOT NULL,                 -- e.g. '2025-04-24'
    source_file    TEXT NOT NULL,
    sha256         TEXT NOT NULL,
    food_count     INT,
    imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset, release_label)
);

CREATE TABLE usda.food (
    fdc_id            INTEGER PRIMARY KEY,
    dataset           TEXT NOT NULL,              -- foundation | sr_legacy | fndds
    description       TEXT NOT NULL,
    food_category     TEXT,
    publication_date  DATE,
    release_id        INT NOT NULL REFERENCES usda.release(id),
    is_current        BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE usda.nutrient (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    unit_name  TEXT NOT NULL
);

CREATE TABLE usda.food_nutrient (
    fdc_id       INTEGER NOT NULL REFERENCES usda.food(fdc_id) ON DELETE CASCADE,
    nutrient_id  INTEGER NOT NULL REFERENCES usda.nutrient(id),
    amount       NUMERIC NOT NULL,                -- per 100 g
    PRIMARY KEY (fdc_id, nutrient_id)
);

CREATE TABLE usda.food_portion (
    id                   INTEGER PRIMARY KEY,
    fdc_id               INTEGER NOT NULL REFERENCES usda.food(fdc_id) ON DELETE CASCADE,
    seq_num              INTEGER,
    amount               NUMERIC,
    measure_unit         TEXT,
    portion_description  TEXT,
    modifier             TEXT,
    gram_weight          NUMERIC NOT NULL CHECK (gram_weight > 0)
);
CREATE INDEX food_portion_fdc ON usda.food_portion (fdc_id);

-- Flattened, indexed search table (rebuilt per dataset by the importer)
CREATE TABLE public.usda_food (
    fdc_id          INTEGER PRIMARY KEY,
    dataset         TEXT NOT NULL,
    description     TEXT NOT NULL,
    food_category   TEXT,
    kcal_100g       NUMERIC(7,1),
    protein_100g    NUMERIC(6,2),
    carbs_100g      NUMERIC(6,2),
    fat_100g        NUMERIC(6,2),
    fiber_100g      NUMERIC(6,2),
    sugar_100g      NUMERIC(6,2),
    sodium_mg_100g  NUMERIC(8,1),
    portions        JSONB NOT NULL DEFAULT '[]',   -- [{"label":"1 cup, chopped","grams":128}]
    is_current      BOOLEAN NOT NULL,
    search_text     TEXT NOT NULL,                 -- lower(description || ' ' || coalesce(category,''))
    search_tsv      TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED
);
CREATE INDEX usda_food_trgm ON public.usda_food USING gin (search_text gin_trgm_ops);
CREATE INDEX usda_food_tsv  ON public.usda_food USING gin (search_tsv);
CREATE INDEX usda_food_current ON public.usda_food (is_current);

GRANT USAGE ON SCHEMA usda TO claude_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA usda TO claude_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA usda GRANT SELECT ON TABLES TO claude_readonly;
GRANT SELECT ON public.usda_food TO nutrition_writer;      -- for server-side compute (D6)
```

The importer builds each `usda_food` row with these FDC nutrient IDs. They are
values per 100 g, and each field takes the first non-null in the list:

| Field | Nutrient ids (first non-null wins) | Why the fallback |
|---|---|---|
| kcal | 1008, 2048, 2047 | Many Foundation foods have no 1008, only the Atwater energies |
| protein | 1003 | |
| carbs | 1005, 1050 | Some Foundation foods have only "by summation" |
| fat | 1004, 1085 | Some Foundation foods have only NLEA total fat |
| fiber | 1079 | |
| sugar | 2000, 1063 | SR Legacy uses 2000; Foundation uses 1063 |
| sodium | 1093 | |

T3.2 confirms these IDs against `nutrient.csv` in the downloaded release before
loading, and fails loudly if any are missing.

### 4.5 Down scripts (summary)

| Migration | Down |
|---|---|
| 01 food_log | `DROP VIEW food_log_daily; DROP TABLE food_log_audit, food_log, my_food_aliases, my_foods; DROP FUNCTION food_log_audit_fn(), touch_updated_at(); REVOKE … ; DROP ROLE nutrition_writer;` **Destroys logged food.** The down script refuses to run if `food_log` has rows, unless `-v force=1` is passed. |
| 02 view | `DROP VIEW nutrition_daily; ALTER TABLE nutrition_daily_legacy RENAME TO nutrition_daily; ALTER INDEX … RENAME …; DROP TABLE nutrition_day_status, nutrition_goals;` `food_log` is untouched, so no logged data is lost. |
| 03 usda | `DROP TABLE public.usda_food; DROP SCHEMA usda CASCADE;` USDA data can be re-imported, so nothing irreplaceable is lost. |

---

## 5. MCP tool specs

These rules apply to every tool:

- Input is validated with zod. Each tool returns `content: [{type:'text', text: JSON}]`
  and `structuredContent` with the same object.
- Errors return `isError: true` with
  `{ "error": { "code", "message", "item_index"?, "field"? } }`.
- NUMERIC values are converted to JS numbers inside the nutrition module. The
  global `pg` type parser is not changed, so the `query` tool's output stays
  byte-identical.
- Tool annotations are set: `readOnlyHint` on read tools, `destructiveHint` on
  `delete_log_entry`, and `idempotentHint` on `log_food` when it is called with a
  `request_id`.
- **Error codes:** `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `ALREADY_DELETED`,
  `WRITES_DISABLED`, `RATE_LIMITED`, `DB_ERROR`. `DB_ERROR` carries a generic
  message, and the details only go to the journal.
- Every write is logged to the journal as one line: tool, auth client id (or
  `static_key`), affected ids, and calorie delta. Descriptions are not logged.

### 5.1 Server `instructions` (sent at `initialize`), short version

> Food logging: the user tells you what they ate (text or photo). (1) Call
> `search_foods` for each distinct food, using the food name only, without
> quantities. (2) Prefer a favorite if one matches. Otherwise use a USDA match
> with a portion, otherwise your own estimate. (3) Call `log_food` once with all
> the items. (4) Show the user a compact table: item, amount, kcal, P/C/F,
> confidence and source, plus the day's running total from the response. Set
> `confidence` honestly: high = favorite, or a weighed or packaged label;
> med = USDA match with a portion stated in standard units; low = photo, vague
> portion, restaurant guess or mixed dish. Never present an estimate as exact.
> If something is eaten repeatedly, offer to `save_favorite`.

### 5.2 `search_foods` (read, pool A)

Description: "Search the user's saved favorites first, then USDA reference foods.
Call this before logging. Use the food name only (e.g. 'greek yogurt', not '200g
greek yogurt'). Favorites with `exact: true` should be used as-is."

Input:
```json
{ "query": "string, 1-100 chars",
  "limit": "int 1-15, default 8",
  "include_usda": "bool, default true",
  "include_portions": "bool, default true" }
```

Behavior:
1. Normalize the query: lowercase, collapse whitespace, strip digits and units.
   Also make a variant with filler words removed (D8).
2. Favorites: an exact `alias_norm` hit on either variant comes first, then
   `word_similarity ≥ 0.4` (set with `SET LOCAL pg_trgm.word_similarity_threshold`).
   Order by exact desc, score desc, `use_count` desc. Archived foods are
   excluded.
3. USDA (once Phase 3 is done; before that it returns `usda: []` and a note):
   `is_current` rows that match FTS or `<%`, ranked as in D8.

Output:
```json
{ "favorites": [ { "my_food_id": 12, "name": "Usual oatmeal", "matched_alias": "my oatmeal",
                   "exact": true, "score": 1.0, "serving": {"qty":1,"unit":"bowl","grams":320},
                   "per_serving": {"calories":410,"protein_g":22,"carbs_g":58,"fat_g":10,
                                   "fiber_g":8,"sugar_g":14,"sodium_mg":180},
                   "confidence":"high", "basis":"recipe" } ],
  "usda": [ { "fdc_id": 173904, "description": "Cereals, oats, regular and quick, unenriched, cooked with water",
              "dataset":"sr_legacy", "category":"Breakfast Cereals", "score":0.71,
              "per_100g": {"calories":71, "protein_g":2.5, "...": "..."},
              "portions": [{"label":"1 cup","grams":234}] } ],
  "hint": "Exact favorite match: log with match_source='favorite', my_food_id=12." }
```

Errors: `VALIDATION_ERROR` (empty or too long query).

### 5.3 `log_food` (write, pool B)

Description: "Log one or more food items the user ate, all in one call. Check
favorites with search_foods first. For a favorite pass my_food_id + servings, and
for USDA pass fdc_id + grams; the server computes nutrients when you omit them.
Otherwise provide your estimate. Always set confidence honestly. Returns what
was stored plus the day's totals; show them to the user."

Input:
```json
{ "request_id": "uuid, optional, strongly recommended (makes retries safe)",
  "items": [  // 1..25
    { "description": "string 1-200, required, e.g. 'Scrambled eggs'",
      "meal": "breakfast|lunch|dinner|snack, optional (server infers from LA time)",
      "eaten_at": "ISO-8601, optional; no offset = America/Los_Angeles local",
      "day": "YYYY-MM-DD, optional; used with meal when eaten_at absent",
      "quantity": "number > 0, optional", "unit": "string ≤40, optional",
      "grams": "number 0-5000, optional",
      "servings": "number > 0, favorites only, default 1",
      "calories": "number 0-5000", "protein_g": "0-500", "carbs_g": "0-1000", "fat_g": "0-500",
      "fiber_g": "optional", "sugar_g": "optional", "sodium_mg": "optional",
      "confidence": "high|med|low, required",
      "match_source": "favorite|usda|restaurant|estimate, required",
      "my_food_id": "int, required if favorite",
      "fdc_id": "int, required if usda",
      "ref_label": "string ≤200, optional (restaurant/source name)",
      "notes": "string ≤500, optional" } ],
  "allow_backfill": "bool, default false" }
```

Behavior:
1. Check the kill switch and the rate limit (default 120 write calls per hour per
   process).
2. If `request_id` was already used, return the existing rows with
   `"duplicate": true`. No insert happens.
3. Resolve time. `eaten_at` must fall within [now − 60 days, now + 6 h] unless
   `allow_backfill` is set. Resolve `meal` (D7).
4. Resolve references. A favorite must exist and not be archived. A USDA item
   must exist in `usda_food` (from Phase 3; before then `match_source='usda'`
   requires explicit nutrients). Compute missing nutrients (D6). If calories,
   protein, carbs or fat are still missing, return `VALIDATION_ERROR`.
5. Run one transaction: insert all items (every item or none), bump `use_count`
   and `last_used_at` on the favorites used, and read `food_log_daily` for each
   affected day.
6. Return:
```json
{ "logged": [ { "id": 881, "day": "2026-10-25", "meal": "breakfast", "description": "...",
                "calories": 410, "protein_g": 22, "carbs_g": 58, "fat_g": 10,
                "confidence": "high", "match_source": "favorite", "computed_by_server": true } ],
  "warnings": [ { "item_index": 1, "code": "ATWATER_MISMATCH", "message": "..." } ],
  "day_totals": { "2026-10-25": { "calories": 1240, "protein_g": 88, "...": "...",
                  "items": 5, "estimated_calorie_share": 0.31,
                  "goal_calories": 2300, "remaining_calories": 1060 } },
  "duplicate": false }
```
`goal_calories` and `remaining_calories` appear once `nutrition_goals` exists
(Phase 2).

Errors: `VALIDATION_ERROR` (with `item_index` and `field`), `NOT_FOUND`
(unknown `my_food_id`/`fdc_id`), `WRITES_DISABLED`, `RATE_LIMITED`, `DB_ERROR`.

### 5.4 `save_favorite` (write)

Description: "Save or update a recurring food so future mentions resolve
instantly. Use when the user says 'save this', or after the same item is logged
more than twice. Include natural aliases the user says ('my oatmeal', 'usual
oatmeal')."

Input:
```json
{ "id": "int, optional: update this favorite instead of creating",
  "name": "string 1-120 (required on create)",
  "aliases": ["string 1-120", "... up to 10"],
  "remove_aliases": ["... optional"],
  "serving_qty": "number, default 1", "serving_unit": "string, default 'serving'",
  "serving_grams": "number, optional",
  "calories": "...", "protein_g": "...", "carbs_g": "...", "fat_g": "...",
  "fiber_g": "...", "sugar_g": "...", "sodium_mg": "...",
  "confidence": "high|med|low", "basis": "label|usda|recipe|restaurant|estimate",
  "fdc_id": "int, optional",
  "from_log_id": "int, optional: copy nutrients/serving from a food_log row",
  "archive": "bool, optional: archive this favorite (removes its aliases)",
  "notes": "string, optional" }
```

Behavior: one transaction. The name is always added as an alias. Aliases are
normalized. With `from_log_id`, nutrients, serving and basis are copied from
that row, and any explicitly passed field overrides them.

Errors:
- `CONFLICT` when the name or an alias is already used by another active
  favorite. The response lists the alias and the owning `my_food_id`.
- `NOT_FOUND` for an unknown `id` or `from_log_id`.
- `VALIDATION_ERROR`.

### 5.5 `update_log_entry` (write, Phase 2)

Description: "Correct a logged item (wrong portion, wrong meal, wrong day,
better estimate). Get ids from get_day_summary."

Input:
```json
{ "id": "int, required",
  "patch": { "...any of": "eaten_at, day, meal, description, quantity, unit, grams, servings, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, confidence, match_source, my_food_id, fdc_id, ref_label, notes" } }
```

Behavior: patching `servings` on a favorite entry, or `grams` on a USDA entry,
without nutrients recomputes them from the reference. The audit trigger records
the before and after values. Returns `{before, after, day_totals}`, with totals
for both days if the day changed.

Errors: `NOT_FOUND`, `ALREADY_DELETED` (restore it first), `VALIDATION_ERROR`
(including a patch that would break a CHECK constraint).

### 5.6 `delete_log_entry` (write, Phase 2)

Description: "Remove logged items (soft delete; reversible with restore=true).
Confirm with the user before deleting more than 3 items."

Input:
```json
{ "ids": "int[1..25]", "restore": "bool, default false" }
```

Behavior: sets or clears `deleted_at`. Idempotent: rows already in the target
state are reported in `unchanged`. Returns
`{affected:[ids], unchanged:[ids], day_totals}`.

Errors: `NOT_FOUND` (lists the missing ids; nothing is changed),
`VALIDATION_ERROR`.

### 5.7 `get_day_summary` (read, pool A)

Description: "Show what's logged for a day (default: today in LA): totals, goal,
remaining, per-meal breakdown and every item with its id, confidence and source."

Input:
```json
{ "day": "YYYY-MM-DD, optional", "include_items": "bool, default true" }
```

Output: `{day, source: 'food_log'|'legacy'|'none', totals, goals, remaining,
by_meal, items:[{id, eaten_at_local, meal, description, quantity, unit, grams,
nutrients…, confidence, match_source, ref_label}], estimated_calorie_share,
items_missing_micros, logged_complete}`. A legacy day returns totals only, with
`"note": "historical import, no item detail"`.

Errors: `VALIDATION_ERROR` (bad date).

### 5.8 `mark_day_complete` (write, Phase 2)

Input: `{ "day": "YYYY-MM-DD, default today", "complete": "bool", "note": "optional" }`.
It upserts `nutrition_day_status`, which feeds `nutrition_daily.logged_complete`
for `food_log` days.

### 5.9 Unchanged tools

`list_tables`, `describe_table` and `query` keep their code, pool and guard.
T0.1 adds tests that pin their behavior, so later tasks cannot change them by
accident.

---

## 6. Expected conversational flow (client side, documented, not built)

**Text, typical:** "Breakfast was my usual oatmeal and two scrambled eggs, coffee
with a splash of milk."

1. Claude splits this into three foods. It calls `search_foods` for "usual
   oatmeal", "scrambled eggs" and "coffee with milk" (in parallel when the
   client supports it).
2. Oatmeal is an exact favorite: `match_source=favorite`, `confidence=high`, the
   server computes the nutrients. Eggs match USDA "Egg, whole, cooked,
   scrambled" with a portion of 1 large = 61 g, so 2 × 61 g = 122 g,
   `confidence=med`. Coffee with milk has no USDA match, so Claude estimates
   about 15 kcal, `match_source=estimate`, `confidence=low`.
3. Claude makes one `log_food` call with a fresh `request_id`.
4. Claude replies with a 3-row table (kcal, P/C/F, confidence, source), the
   day's total and the calories remaining. It adds a one-line offer: "Say 'fix
   eggs to 3' or 'remove coffee' to correct."

**Photo:** Claude identifies the items and estimates portions from visual cues.
Items are at most `med` and usually `low`, and Claude says so in the reply.
Mixed dishes use `estimate` or a USDA/FNDDS match. Recommended policy: log
right away and show the result (Q4).

**Corrections:** "Actually that was 3 eggs." Claude calls `get_day_summary` if it
does not already have the id, then `update_log_entry` with `{grams: 183}`, and
the server recomputes.

**Favorites:** after the same estimated item shows up a third time, Claude
offers "Save 'Starbucks oat latte grande' as a favorite?" and calls
`save_favorite` with `from_log_id`.

**Retroactive:** "Yesterday's dinner was …" gives `day` + `meal=dinner`, and the
server uses 19:00 LA.

Optionally, put the §5.1 text into a claude.ai Project instruction or a Claude
Code skill too. That is belt and braces, because not every client surfaces MCP
server `instructions`.

---

## 7. USDA import process

### 7.1 Sources

FoodData Central "Download Datasets" page (fdc.nal.usda.gov), **CSV** format:

| Dataset | Content | Approx. size (zip / unzipped) | Foods kept | Refresh |
|---|---|---|---|---|
| **SR Legacy** (required) | Classic USDA SR28 reference, final release April 2018 | ~6–7 MB / ~50 MB | 7,793 | Never (frozen) |
| **Foundation** (required) | Analytically measured staples, with richer metadata | a few MB / ~30–60 MB (`food_nutrient` includes sub-sample rows) | a few hundred (`data_type = 'foundation_food'` only) | ~2× per year (typically April and October/December) |
| FNDDS / Survey (optional, recommended) | ~5,400 "as eaten" foods and mixed dishes with portion weights ("Burrito, chicken and beans", "Pizza, cheese, from restaurant") | ~10–30 MB zipped | ~5,400 | ~every 2 years |
| Branded (optional, deferred) | Label data from manufacturers, GTIN/UPC | ~400–500 MB / ~3 GB | ~0.5–2 M records (FDC keeps historical versions) | Monthly |

Exact sizes and counts are recorded by the importer for each release, in
`usda.release`. The numbers above are order-of-magnitude figures for planning.

Files read from each zip: `food.csv`, `nutrient.csv`, `food_nutrient.csv`,
`food_portion.csv`, `measure_unit.csv`, `food_category.csv`, plus
`foundation_food.csv` or `sr_legacy_food.csv` to confirm membership. Before
loading, the importer checks each file's header columns against what it expects
and aborts if FDC has changed the format.

### 7.2 Load method

Script: `health_data_hub/etl/usda/import_fdc.py`. It is Python, to match the
repo's psycopg2 and pytest conventions. You run it by hand on the Pi as the
scheduler's DB user (`postgres`, from `prod.env`).

```
python -m health_data_hub.etl.usda.import_fdc --dataset sr_legacy --zip ~/usda/FoodData_Central_sr_legacy_food_csv_2018-04.zip [--dry-run]
```

1. Download the zip with `curl` into a fresh, empty directory (`~/usda/<release>/`).
   Record its SHA-256. The zip is data only: the importer streams CSV members
   with `zipfile` and never extracts or executes anything from it.
2. `COPY … FROM STDIN (FORMAT csv, HEADER)` each needed CSV into
   `UNLOGGED` staging tables in a temporary schema `usda_stage`. All columns are
   text.
3. In **one transaction**:
   - upsert `usda.release`, `usda.nutrient` and `usda.food` (filtered to the
     dataset's data_type)
   - replace `food_nutrient` and `food_portion` for those `fdc_id`s
   - set `is_current = false` for foods of this dataset that are missing from
     this release
   - `DELETE FROM public.usda_food WHERE dataset = $1`, then
     `INSERT … SELECT` the flattened rows (nutrient mapping in §4.4, and portions
     aggregated to JSONB as `"<amount> <unit or modifier>"` labels)
   - keep non-current rows in `usda_food` with `is_current = false`
4. `DROP SCHEMA usda_stage CASCADE`, then `ANALYZE usda.*, public.usda_food`.
5. Print a summary: foods inserted, updated and retired; rows per table; how
   many foods have no kcal (expected to be close to zero after the fallbacks);
   elapsed time.

`--dry-run` stops after step 2 and prints the counts.

### 7.3 Resource impact on the Pi (Foundation + SR Legacy)

- **Disk:** `usda.food_nutrient` is roughly 650k–800k rows × about 60 B, plus
  the PK, which comes to about 60–90 MB. `usda_food` with its GIN indexes is
  under 10 MB. Expect about **100–150 MB** in total, which takes `health_pi`
  from 197 MB to roughly 350 MB. During the load, WAL briefly grows to about the
  size of the data.
- **Time:** COPY of about 1M rows plus the transform and indexes should take
  around 30–90 s on a Pi 5 with the database on the USB SSD.
  `maintenance_work_mem` is 64 MB, which is enough for GIN indexes on about 9k
  rows.
- **Memory and CPU:** a single backend, well inside current settings.
  `shared_buffers` is at the 128 MB default. That is fine for this, but worth
  raising separately if RAM allows.
- **When:** run outside scheduler activity. Jobs run 05:00–23:40, so 01:00–04:00
  is safe. The import does not lock `food_log`. `search_foods` only sees the old
  or new `usda_food` at transaction boundaries.
- **Backups:** USDA data is reproducible, so routine dumps can use
  `--exclude-schema=usda`. Keep `public.usda_food` in the dump, or exclude it
  too, since it can also be rebuilt.

### 7.4 Branded: assessment and recommendation

A full normalized load means tens of millions of `food_nutrient` rows. That is
roughly 3–5 GB in Postgres plus several hundred MB of trigram index. The import
would take hours on a Pi and need monthly refreshes.

A trimmed alternative is one wide table: latest record per GTIN, the 7 tracked
nutrients, brand, description, and serving size. That should land at roughly
0.3–0.8 GB with indexes, with an import of about 10–30 minutes.

**Recommendation: defer.** Since there is no barcode scanning, Branded's main
value is brand-name lookups. Claude usually knows label values for common
products, and favorites capture the branded items you actually repeat.

If you want it later, T4.1 measures the real numbers from the current release
and makes a go/no-go call against these limits: under 1 GB on disk, under
30 minutes to import, and `search_foods` p95 under 300 ms.

### 7.5 Open Food Facts: skip

The full dump is about 9 GB or more uncompressed, with 3M+ mostly non-US
products and uneven data quality. Without barcode scanning there is little gain
over USDA plus Claude's own knowledge. Reconsider only if Branded is rejected
and brand coverage turns out to be a real gap.

### 7.6 FNDDS: optional, worth it

FNDDS is small, and it is the USDA dataset closest to how people describe meals,
with its mixed dishes and restaurant-style foods. Adding it is mostly a mapping
exercise, because it uses the same importer and the same `usda_food` table with
`dataset = 'fndds'`. Q7.

### 7.7 Refresh cadence

- SR Legacy: load once.
- Foundation: check in April and December, and re-run the importer if a new
  release exists. A quality check (T3.6) warns when the newest Foundation
  `release_label` is more than 9 months old.
- FNDDS: check yearly.
- All refreshes are manual. No scheduler job is needed at this cadence.

---

## 8. Phased delivery

Each task is independently testable. **[protected]** means the task touches a
path in `kit.json` `protectedPaths`, so under the kit pipeline it needs your
approval or you apply it yourself. **[live]** means it involves a step on the Pi.

Node test command: `cd health-mcp && node --test`.
Integration tests also need `TEST_DATABASE_URL`.

### Phase 0: safety and harness

**T0.1 health-mcp test harness, no behavior change** [sonnet, normal]
- Outcome: `server.mjs` is split into `app.mjs` (Express app factory), `db.mjs`
  (pool factory) and `tools/read.mjs`, with `server.mjs` as a thin entry point.
  The `test/` directory runs under `node --test`.
- Acceptance:
  - (a) `assertReadOnlySql` accepts and rejects a fixed table of inputs.
  - (b) `query` against a fake pool wraps SQL with `LIMIT ${MAX_ROWS}`.
  - (c) Host-header check returns 421.
  - (d) `/mcp` without a bearer token returns 401 with a `WWW-Authenticate`
    header.
  - (e) `tools/list` returns exactly the 3 current tools with unchanged
    descriptions.
- Done when: `cd health-mcp && node --test`.

**T0.2 Integration test database** [sonnet, normal]
- Outcome: `scripts/test-db.sh` creates a throwaway `health_test` database from
  `schema.sql` plus all migrations, and creates roles named `claude_readonly_t`
  and `nutrition_writer_t` (configurable names). Node integration tests skip
  when `TEST_DATABASE_URL` is unset. A CI job runs a `postgres:18` service and
  `node --test`. **[protected: .github]**
- Acceptance: the CI job is green, and locally the integration suite runs
  against Windows Postgres.

**T0.3 Migration ledger** [haiku, normal] **[protected]**
- Outcome: migration `00` (§4.1) plus `scripts/migrate.sh <file>`, which applies
  a file in a single transaction, records it, and refuses a re-run.
- Acceptance: applying twice exits non-zero the second time, and the ledger has
  one row.

**T0.4 Backup and restore drill** [human, live]
- Outcome: `pg_dump -Fc health_pi` taken on the Pi and copied off the Pi.
  `pg_restore --list` is checked. The dump is restored into a scratch database
  and row counts are compared.
- Why: `food_log` is the first data in the hub that **cannot be re-pulled from
  an API**. See Q8 and §10.

### Phase 1: MVP (`food_log` + `my_foods` + `log_food` end to end)

**T1.1 Core schema and writer role** [sonnet, high] **[protected]**
- Outcome: migration `01` (§4.2) and its down script, plus a mirror in
  `schema.sql`.
- Acceptance (integration):
  - (a) `day` for `2026-10-25T23:30-07:00` is 10-25, and for
    `2026-10-26T00:30-07:00` it is 10-26.
  - (b) Across DST end: `2026-11-01T01:30-07:00` and `2026-11-01T01:30-08:00`
    are both 11-01, and `2026-11-02T07:59Z` is 11-01.
  - (c) The column stays correct with session `TimeZone = 'UTC'`.
  - (d) CHECK constraints reject: favorite without `my_food_id`, negative
    calories, an unknown meal.
  - (e) Unique `(request_id, request_line)`.
  - (f) Insert, update and soft delete each produce one audit row with the
    right action.
  - (g) The writer **cannot** DELETE from `food_log`, cannot UPDATE
    `created_via`, and cannot SELECT `workout_samples`.
  - (h) `claude_readonly` can SELECT `food_log` and `food_log_daily`, and its
    INSERT fails.
  - (i) The writer can insert without any sequence grant.
  - (j) The down script refuses when rows exist.

**T1.2 Server plumbing for writes** [sonnet, high] **[protected: oauth.mjs consent text]**
- Outcome:
  - pool B (`DB_WRITER_USER`/`DB_WRITER_PASSWORD`)
  - `mcpAuth` sets `req.auth = {clientId}` so tool handlers receive `authInfo`
  - `WRITE_TOOLS_ENABLED` (default `false`, so write tools are not registered)
  - an in-memory rate limiter
  - a structured error helper
  - write-audit journal lines
  - server `instructions`
  - consent page text "read your health data and log food"
- Acceptance:
  - (a) With the flag off, `tools/list` is unchanged from T0.1(e).
  - (b) Integration: the `query` tool's `SELECT current_user` returns
    `claude_readonly` even with pool B configured.
  - (c) The rate limiter returns `RATE_LIMITED` on call N+1.
  - (d) Journal lines never contain descriptions or tokens.

**T1.3 `log_food`** [sonnet, high]
- Outcome: §5.3, with favorite computation (D6). The USDA path requires
  explicit nutrients until Phase 3.
- Acceptance (integration):
  - (a) A 3-item batch inserts 3 rows and returns `day_totals`.
  - (b) A batch with an invalid item 2 inserts nothing and returns
    `VALIDATION_ERROR` with `item_index: 1`.
  - (c) The same `request_id` twice gives one set of rows, and the second call
    has `duplicate: true`.
  - (d) A favorite with `servings: 1.5` and no nutrients gives 1.5× the
    favorite's values and `computed_by_server: true`.
  - (e) `eaten_at` without an offset is read as LA time.
  - (f) `day` + `meal=dinner` gives 19:00 LA.
  - (g) An `eaten_at` 90 days ago is rejected unless `allow_backfill` is set.
  - (h) An Atwater mismatch gives a warning and still inserts.
  - (i) An archived favorite gives `NOT_FOUND`.
  - (j) `use_count` is incremented.

**T1.4 `save_favorite` + `search_foods` (favorites tier)** [sonnet, normal]
- Acceptance:
  - (a) Create with aliases, and "my usual oatmeal" finds alias "usual oatmeal"
    with `exact: true`.
  - (b) "oatmeal" finds it by trigram.
  - (c) A duplicate alias gives `CONFLICT` naming the owner.
  - (d) `from_log_id` copies the nutrients.
  - (e) Archiving removes it from search.
  - (f) `search_foods` uses pool A.

**T1.5 `get_day_summary`** [sonnet, normal]
- Acceptance:
  - (a) Default day is today in LA (with a frozen clock at 23:30 PT).
  - (b) Items include ids and are ordered by `eaten_at`.
  - (c) Soft-deleted items are excluded.
  - (d) Before Phase 2, `goals` is null.

**T1.6 Deploy and end-to-end** [human, live]
- Steps:
  1. `migrate.sh 01`.
  2. Set the `nutrition_writer` password and add `DB_WRITER_*` and
     `WRITE_TOOLS_ENABLED=true` to `health-mcp.env`.
  3. `git pull` and `npm ci`, then restart `health-mcp`.
- Acceptance:
  - (a) From **claude.ai mobile**: "I had 2 eggs and toast for breakfast"
    produces rows that are visible via the `query` tool.
  - (b) The same works from Claude Code using the static key.
  - (c) `get_day_summary` matches `SELECT … FROM food_log_daily`.
  - (d) `journalctl -u health-mcp` shows the write audit lines.
  - (e) The existing `query` tool still returns workouts.
- **MVP done.**

### Phase 2: corrections and daily totals in `nutrition_daily`

**T2.1 `update_log_entry` + `delete_log_entry`** [sonnet, normal]
- Acceptance: §5.5 and §5.6 behaviors. Restoring returns the row. Moving a
  patch to another day returns totals for both days. A deleted row is gone from
  `food_log_daily`.

**T2.2 Goals and day status** [sonnet, normal] **[protected]**
- Outcome: the first half of migration `02` (tables and grants), plus the
  `mark_day_complete` tool and goals in `get_day_summary`.
- Acceptance: the goal in effect is the latest `effective_from` on or before the
  day, and the `oura_active` adjustment adds `cal_active × factor`.

**T2.3 `nutrition_daily` view** [opus, high] **[protected]** **needs your approval (Q2)**
- Outcome: the rest of migration `02`, the `schema.sql` change (C5) and the down
  script.
- Acceptance (integration, on a copy of the 55 real rows via `pg_dump -t`):
  - (a) `SELECT * FROM nutrition_daily ORDER BY day` is **identical** before and
    after the migration when `food_log` is empty: all 18 columns, with types
    compared via `pg_typeof`.
  - (b) Adding `food_log` rows on a legacy day replaces that day with
    `source='food_log'`, with no double count.
  - (c) Soft-deleting them brings the legacy row back.
  - (d) `meals_json` keys are `breakfast/lunch/dinner/snacks`.
  - (e) The queries from `export_daily_json.py` and `notion-reporter` `db.mjs`,
    run verbatim, return the same shape.
  - (f) `init_db.py` on a fresh database succeeds, and a second run is a no-op.
  - (g) The down script restores the original table, and (a) still passes.

**T2.4 Apple Health nutrition poller** [sonnet, normal] **needs your answer (Q1)**
- Option A (recommended): remove the `nutrition_poller` job from
  `scheduler_all.py`, keep the module, and archive `lock_nutrition.py` (and its
  cron line) per [archive/ARCHIVED.md](../archive/ARCHIVED.md).
- Option B: point `insert_nutrition_daily.py` at `nutrition_daily_legacy`, skip
  all-NULL payloads, and fix the Worker mapping (C14).
- Acceptance:
  - A: the scheduler has no `nutrition_poller` job, and the tests pass.
  - B: an all-NULL payload does not upsert, and the existing tests are updated.

**T2.5 Quality checks** [haiku, normal]
- Outcome: in `checks_health.py`, retarget the nutrition freshness check to
  `food_log`'s `created_at` (warn after 24 h), and add a check that no
  `food_log` day has more than 8,000 kcal.
- Acceptance: unit tests in the existing FakeConn style.

**T2.6 Docs** [haiku, normal]
- Outcome: update the `health-mcp/README.md` tools section, data model (C3) and
  "Defense in depth" for writes. Add a `docs/nutrition_logging.md` user guide
  with the flow from §6.

### Phase 3: USDA

**T3.1 USDA schema** [sonnet, normal] **[protected]**
- Outcome: migration `03` (§4.4).
- Acceptance: `claude_readonly` can SELECT `usda.food` and the writer can SELECT
  `usda_food`.

**T3.2 Importer** [sonnet, high]
- Outcome: §7.2, with pytest unit tests over small fixture CSVs and an
  integration test against `health_test`.
- Acceptance:
  - (a) A header mismatch aborts before any write.
  - (b) A Foundation fixture with only nutrient 2047 still gets a kcal value.
  - (c) Sugar falls back to 1063.
  - (d) Re-importing the same release is a no-op.
  - (e) A newer fixture release marks missing foods `is_current = false`.
  - (f) Portions JSON has labels and grams.
  - (g) `--dry-run` writes nothing.
  - (h) A failure mid-way leaves the previous data intact.

**T3.3 Load on the Pi** [human, live]
- Outcome: SR Legacy, then Foundation, loaded with a backup taken first.
- Acceptance: about 7.8k SR Legacy foods plus the Foundation count, the elapsed
  time and disk delta recorded in `usda.release`, and under 1% of current foods
  without kcal.

**T3.4 `search_foods` USDA tier + golden set** [sonnet, normal]
- Outcome: a golden-set test of about 25 queries, for example "banana",
  "scrambled eggs", "chicken breast", "greek yogurt plain", "almonds", "olive
  oil", "white rice cooked", "broccoli", "salmon", "oatmeal", "avocado", "whole
  milk", "cheddar cheese", "peanut butter", "apple".
- Acceptance: for each query, a sensible food is in the top 3 (by hand-curated
  expected `fdc_id`s), and p95 latency is under 150 ms on the Pi.

**T3.5 USDA computation in `log_food` and `update_log_entry`** [sonnet, normal]
- Acceptance: `fdc_id` + `grams: 150` and no nutrients give 1.5× the per-100 g
  values. A model value more than 30% off gives a warning.

**T3.6 Release-age quality check** [haiku, normal]

### Phase 4: optional

- **T4.1 Branded assessment.** Measure the current release (rows, CSV size,
  trial load of the trimmed table on the Pi), then make a go/no-go call against
  the §7.4 limits. Nothing ships without your decision.
- **T4.2 FNDDS import** (Q7).
- **T4.3 Convenience tools.** `recent_foods` (the most frequent items in the
  last 14 days) and `copy_meal` (`{from_day, meal, to_day}`, for "same lunch as
  yesterday").
- **T4.4 OAuth hardening** **[protected]**. Refresh-token expiry (90 days) and
  rotation, SHA-256 hashing of tokens in `oauth-state.json`, and an endpoint or
  script to revoke all tokens.
- **T4.5 Connect privileges.** `REVOKE CONNECT, TEMP ON DATABASE health_pi FROM
  PUBLIC` with explicit grants, and the same for the `n8n` database (C10). This
  needs Q10 answered first, so no n8n workflow breaks.

### Phase 5: voice note → `food_log` (optional)

**Recommended, option A (Claude-in-the-loop):** the iOS Shortcut sends a note
whose transcript starts with "food" or "ate", or n8n tags it. In any Claude
session, "process my food notes" makes Claude call Voice-Notes
`list_pending_recordings` and `get_transcript`, then `search_foods` and
`log_food` with `created_via` set to `'claude_mcp'` and `notes` set to
`voice:<recording id>`, then `mark_status`.

There is no new infrastructure, estimation quality stays the same, and the n8n
guardrail (C9) is respected. The cost is that it is not fully hands-free: you
have to ask Claude to process the notes.

- T5.1: n8n tags food notes. This is a small change in the `n8n-stack` repo, not
  this one.
- T5.2: a short "process food notes" section in the user guide.

**Option B (hands-free):** n8n extracts the items with its LLM, calls
`search_foods`-equivalent SQL for favorites, and INSERTs into `food_log` with
`created_via='voice_n8n'` under a new INSERT-only role, `food_log_n8n`.

Option B needs you to lift the `health_pi` read-only guardrail for n8n. It also
puts a second estimator (gpt-oss) into the data, with weaker favorite matching.
Only do it if option A turns out to be too much friction.

---

## 9. Testing plan

| Layer | Tooling | What it covers |
|---|---|---|
| SQL and DDL | `node --test` integration against Postgres 18 (`health_test`) | Generated `day` across DST, CHECKs, audit trigger actions, **role permission matrix** (allowed and denied operations per role, table driven), view parity (T2.3a), down scripts |
| MCP tools | `node --test` with a fake pool (unit) and a real database (integration) | zod bounds, error codes, idempotency, all-or-nothing batches, computation and warnings, pool routing (`query` → `claude_readonly`), kill switch, rate limiter, NUMERIC→number conversion that leaves `query` untouched |
| Protocol | `node --test` driving the Express app over HTTP | `initialize`, `tools/list` snapshot, `tools/call` round trip, 401/421 paths, annotations present |
| Python | pytest (existing FakeConn style) | Importer parsing and mapping, quality checks, poller change |
| Search quality | Golden set (T3.4) | Ranking regressions when weights or data change |
| Regression of readers | T2.3(e) | `export_daily_json` and `notion-reporter` SQL run verbatim |
| End to end | Manual script (T1.6) | claude.ai mobile, claude.ai web, Claude Code; a photo log; a correction; a favorite round trip |

CI: add a Node job (`postgres:18` service, `npm ci`, `node --test`) next to the
existing pytest job.

---

## 10. Backup and rollback

**Before each migration (T1.6, T2.3, T3.3):**
```bash
pg_dump -U postgres -Fc -d health_pi -f ~/backups/health_pi_$(date +%F_%H%M)_pre-<migration>.dump
pg_restore --list <file> | grep -c 'TABLE DATA'     # sanity check
scp <file> <off-Pi destination>
```

**Rollback ladder (least to most invasive):**
1. **Bad tool behavior:** set `WRITE_TOOLS_ENABLED=false` and restart
   `health-mcp`. The write tools disappear and the reads keep working.
2. **Bad writes:** the audit table holds every earlier version. A row can be
   restored by `UPDATE food_log … FROM food_log_audit` as `postgres`, or with
   `delete_log_entry restore=true` for soft deletes.
3. **Bad server release:** `git checkout <previous tag>`, `npm ci`, restart.
4. **Bad view (T2.3):** run the down script for `02`. `nutrition_daily` is a
   table again with all 55 original rows, and `food_log` is untouched. Readers
   then just miss new days until the fix lands.
5. **Bad schema (T1.1):** run the down script for `01` with `force=1`, only if
   `food_log` is empty or has been dumped first.
6. **Disaster:** `pg_restore` the pre-migration dump into a fresh database and
   swap.

**Ongoing:** I found no automated backup of `health_pi` in the repo (Q8). Once
`food_log` exists, losing the database loses data that no API can restore.
Recommended: a nightly `pg_dump -Fc --exclude-schema=usda` from cron, keeping 14
days, plus a weekly off-Pi copy.

---

## 11. Security review notes

- **Read-only guarantee:** the `query` tool keeps its own pool bound to
  `claude_readonly` (`default_transaction_read_only = on`) and its app-layer
  guard. A test pins `current_user` for it (T1.2b). Pool B is never passed to
  read tools.
- **Least privilege:**
  - `nutrition_writer` has no DELETE on `food_log` or `my_foods`, and
    column-level UPDATE on `food_log`.
  - It has no access to workouts, Oura, body data or any schema besides
    `public`'s 7 nutrition objects (and `usda_food` read-only).
  - It is capped at 3 connections and has `statement_timeout` 5 s.
  - `search_path` is pinned.
- **Injection:** all values are bound parameters. There are no dynamic
  identifiers, ORDER BY fields or LIKE patterns built from input. Search text is
  passed to `websearch_to_tsquery` and the trigram operators as a parameter.
- **Prompt injection, the main new risk:** any content in a Claude conversation
  (a web page, a document, a stored food description) could push the model to
  call write tools. Mitigations:
  - soft delete plus the audit trail, so everything is reversible
  - the rate limit and the 25-item batch cap
  - value bounds
  - a tool description asking for confirmation before deleting more than 3 items
  - claude.ai showing tool calls to the user
  - all write tools are additive or reversible, so nothing can exfiltrate data
    that `query` could not already read
- **Auth blast radius (C12):** after this change, any valid OAuth token or the
  static key can write food data. Acceptable for a single-user server, given the
  controls above. T4.4 adds token expiry, rotation and hashing. The consent page
  text changes so you knowingly approve write access.
- **Secrets:** `DB_WRITER_PASSWORD` goes into the existing mode-600
  `health-mcp.env`. It is rotated the same way as the README's
  `claude_readonly` recipe.
- **Logging:** journal lines contain ids, counts and client ids only. They never
  contain descriptions, tokens or SQL.
- **USDA downloads:** treated as untrusted data. The importer streams CSV out of
  the zip with no extraction or execution, validates headers, and records the
  SHA-256 checksum.
- **Unchanged:** Host-header check, localhost bind, tunnel-only exposure, PKCE,
  redirect allowlist.
- **Pre-existing and out of scope, noted:** PUBLIC CONNECT on `health_pi` and
  `n8n` (C10), and the README's inaccurate CONNECT claim.

---

## 12. Open questions

Questions marked **(blocks …)** must be answered before that task runs.

1. **Apple Health nutrition feed (blocks T2.4):** do you still log in any app
   that writes nutrition to Apple Health (MFP, Cronometer)? If not, I recommend
   retiring the 22:00 poller and `lock_nutrition.py`. If yes, should those days
   be ignored once `food_log` has entries? That is the view's current rule.
2. **Approve the `nutrition_daily` → table + view migration (blocks T2.3).**
   Also: do any n8n workflows, or anything outside this repo, **write** to
   `nutrition_daily`? I can only see this repo.
3. **Write access on the existing connector (blocks T1.2/T1.6):** is one
   connector with write tools OK (recommended), or do you want a separate
   write-enabled endpoint?
4. **Log first or confirm first?** I recommend logging immediately and showing
   what was stored, with corrections by voice or text afterwards. The
   alternative is that Claude shows its estimate and waits for "ok" before
   logging, or does that only for photo or low-confidence items.
5. **Goals:** MFP's goals were base plus exercise, with a 30/40/30 split. What
   do you want now?
   - a fixed base goal (what numbers?)
   - base + `oura_active` × factor
   - no goals

   Should protein be a fixed number of grams?
6. **Meals:** are `breakfast/lunch/dinner/snack` enough, or do you want
   `pre_workout`/`post_workout`?
7. **Datasets:** confirm Branded is deferred and Open Food Facts is skipped. Add
   FNDDS (recommended)?
8. **Backups:** is anything outside this repo dumping `health_pi` (cron,
   snapshot, rsync)? If not, should T0.4 also add the nightly dump job?
9. **Voice notes:** is option A (Claude processes tagged notes when asked) OK
   for Phase 5, or do you want hands-free option B, which lifts the n8n →
   `health_pi` read-only guardrail?
10. **n8n and other roles in `health_pi`:** which credential do your n8n
    workflows use to read `health_pi` (`n8n`, `claude_readonly` or `postgres`)?
    The `n8n` role has CONNECT but no table grants. This only matters for T4.5.
11. **Legacy NULL rows:** keep the 13 all-NULL `apple_health` rows as they are
    (they look like days with no data), or delete them during T2.3? I recommend
    deleting them, after the backup.
12. **Backfill window:** is 60 days the right default limit for `eaten_at`
    without `allow_backfill`?
13. **Travel:** confirm that days always count in America/Los_Angeles, even when
    you are in another time zone (the brief says so; I'm checking the
    consequence is intended).
14. **Pipeline:** run Phases 0–3 through the kit pipeline (`/task-plan`), which
    pauses for approval on the many [protected] tasks, or drive them by hand?
