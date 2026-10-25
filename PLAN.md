# Plan: Log food through Claude into health_pi (MVP + nutrition_daily migration)
Branch: orch/nutrition-logging
## Context
- Spec: `docs/nutrition-build-plan.md` (§4 DDL, §5 tool specs). Decisions below override it where they differ. This run = its Phases 0–2. USDA (Phase 3), Phase 4 extras and voice (Phase 5) are follow-up plans.
- `health-mcp/`: Node 22 ESM, express + `@modelcontextprotocol/sdk` ^1.30 + `pg` + `zod`; no tests today. Python package `health_data_hub/` with pytest (`venv/Scripts/python -m pytest -q`).
- Node checks: `cd health-mcp && npm ci --silent && npm test` (unit, no DB) and `npm run test:integration` (needs `TEST_DATABASE_URL` pointing at a local Postgres 18 database whose name ends in `_test`).
- Prod: Postgres 18.3 `health_pi` on the Pi; `claude_readonly` role (SELECT-only, `default_transaction_read_only=on`); default privileges grant it SELECT on new `public` tables.
- `nutrition_daily` readers that must keep working unchanged: `health_data_hub/etl/export_daily_json.py:134`, `notion-reporter/src/utils/db.mjs:105`, `health_data_hub/integrations/apple_health/nutrition_reader.py:50`, `health_data_hub/quality/checks_health.py:124`.
- Protected paths (merge gate holds): `health_data_hub/db/`, `migrations/`, `health-mcp/oauth.mjs`, `.github/`.
- No-touch: `cloudflare-worker/`, `notion-reporter/`, `health_data_hub/config/*.env`, all pollers except the nutrition poller, `query`/`list_tables`/`describe_table` behavior.
- No live steps in this run: Pi backup, migrations on the Pi, writer password, deploy and claude.ai end-to-end happen after merge per the T12 runbook.
## Decisions
- D1 (build-plan Q1): You are turning off the Health Auto Export nutrition export -> remove the 22:00 `nutrition_poller` job from `scheduler_all.py` and move `nutrition_poller.py`, `insert_nutrition_daily.py` and `lock_nutrition.py` to `archive/`. The Cloudflare Worker is left as is.
- D2 (Q2): Approved -> rename table `nutrition_daily` to `nutrition_daily_legacy` (frozen) and create VIEW `nutrition_daily` with identical column names, order and types. A day with any non-deleted `food_log` rows returns `food_log` totals with `source='food_log'`; otherwise it returns the legacy row. Never sum both. Nothing else writes `nutrition_daily`.
- D3 (Q3): Yes -> add the write tools to the existing `/mcp` connector. They use a second `pg` pool as new role `nutrition_writer`. Read tools (including `search_foods` and `get_day_summary`) use the `claude_readonly` pool only.
- D4 (Q4): Show the estimate before logging -> `log_food` takes `confirm` (boolean, default false). With `confirm: false` it validates, computes and returns the would-be rows plus projected day totals, and writes nothing. With `confirm: true` it inserts. The tool description and server `instructions` tell Claude to call without `confirm`, show the table, and call again with `confirm: true` only after the user agrees. This is not enforced by a token.
- D5 (Q5, revised 2026-10-25): The goal is a 100 kg body-weight target. Oura plays no part in calories; the only calories burned that count are from cycling with tracked watts and kJ -> `nutrition_goals(effective_from date PK, target_weight_kg numeric(5,1), base_calories int, cycling_kj_factor numeric(3,2) DEFAULT 1.00, protein_g numeric(6,1), notes text, created_at)`. For a day d: `cycling_kcal = round(cycling_kj_factor * coalesce(sum(workout_summary.kj), 0))` over rows with `sport_type = 'Ride' AND device_watts AND kj > 0 AND start_time::date = d`, and `goal_calories = base_calories + cycling_kcal`. `goal_protein_g = protein_g`. `goal_carbs_g` and `goal_fat_g` are NULL. Seed row: `('2026-10-25', 100.0, 2620, 1.00, 180)`. `get_day_summary` also returns `cycling_kcal`, the latest `body_weight_daily.weight_kg`, its day, and `kg_to_target`.
- D6 (Q14): Run through the kit pipeline. The build-plan §4.3 `exercise_adjust`/`base_calories` goal design is replaced by D5.
## Assumptions
- A1: Unanswered build-plan questions take the doc's recommendations. Meals are `breakfast|lunch|dinner|snack` (Q6). The `eaten_at` backfill window is 60 days (Q12). Days are always in America/Los_Angeles (Q13, per your brief).
- A2: The 13 all-NULL `apple_health` legacy rows are kept (Q11). Deleting data was not approved, and they read the same as today.
- A3: D5 numbers: base 2620 kcal is the earlier estimate you accepted; cycling factor 1.00 (1 kJ of work ≈ 1 kcal burned at ~24% efficiency); protein 180 g (1.8 g/kg of target). They live in one seed row and change with one UPDATE. EBikeRide (no power meter) and rides without kJ add nothing.
- A3b: A ride's day is `start_time::date`, the convention at `health_data_hub/etl/export_daily_json.py:120` and in `analysis_daily_rollup_10d`.
- A4: Before launch you start the local Postgres 18 service (`postgresql-x64-18`, currently stopped), create database `hdh_test`, and set the user env var `TEST_DATABASE_URL=postgres://postgres:<pw>@localhost:5432/hdh_test`. Integration Done-when commands fail if it is unset.
- A5: PR #1 (FTP charts + kit adoption) is merged first and this branch is rebased on the new `main`, so LESSONS.md and the kit files are in the base.
- A6: Test fixtures are synthetic. No real health rows are committed.
- A7: The integration helper sets known passwords on `claude_readonly` and `nutrition_writer` only on the local or CI test cluster, guarded by host ∈ {localhost, 127.0.0.1} and database name ending in `_test`.
## Default policy
- If ambiguous, follow the existing pattern in `health-mcp/server.mjs:101` (zod input, parameterized `pool.query`, `isError` result) and log the choice in the task's Notes.
- Tool errors return `isError: true` with JSON `{"error":{"code","message","item_index"?,"field"?}}`. Codes: `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `ALREADY_DELETED`, `WRITES_DISABLED`, `RATE_LIMITED`, `DB_ERROR` (generic message; details go to stderr).
- SQL: bound parameters only, no SQL text built from tool input. Convert NUMERIC to JS numbers inside `health-mcp/tools/nutrition/` only. Never change the global `pg` type parsers.
- Tests: `node:test` + `node:assert/strict`. Unit tests go in `health-mcp/test/unit/*.test.mjs`, integration tests in `health-mcp/test/integration/*.int.test.mjs` via `health-mcp/test/helpers/testdb.mjs`. Python tests follow the FakeConn style in `tests/test_body_freshness.py`.
- No new npm or pip dependencies.
- Write-tool logging: one `console.log` JSON line `{evt:"write",tool,client,ids,kcal_delta}`. Never log descriptions, tokens or SQL.
- Migrations are plain SQL with no psql meta-commands, and each guards itself: a first `DO` block raises if its name is already in `schema_migrations`, and the last statement inserts its name. Each has a `.down.sql`. `schema.sql` mirrors the end state.
- Report needs-decision only for: user-visible behavior not covered above, data loss, security, cost, or a spec test that looks wrong.
## Tasks
### T1: Split health-mcp into testable modules, no behavior change [model: sonnet] [risk: high] [status: todo] [deps: none]
**Outcome**: `server.mjs` only reads config and calls `createApp(...).listen`. The Express app, auth, the host check and the three read tools live in importable modules, and `npm test` runs unit tests that pin current behavior.
**Files**: `health-mcp/server.mjs`, `health-mcp/app.mjs` (new; move lines 152–201 of server.mjs), `health-mcp/config.mjs` (new; move lines 8–30), `health-mcp/tools/read.mjs` (new; move lines 55–147), `health-mcp/package.json` (add `"test": "node --test \"test/unit/**/*.test.mjs\""`), `health-mcp/test/unit/read-tools.test.mjs` (new)
**Non-goals**: No new tools, no pool or role changes, no change to tool names, descriptions, input schemas, the SQL guard or the HTTP status codes. `oauth.mjs` is untouched.
**Acceptance tests**: `health-mcp/test/unit/read-tools.test.mjs`:
- (a) `assertReadOnlySql` accepts `SELECT 1`, `with x as (select 1) select * from x`, `SELECT 1;`, and rejects `SELECT 1; SELECT 2`, `INSERT INTO t VALUES (1)`, `select 1 where 'x' = 'drop'`, `DELETE FROM t`, `update t set a=1`.
- (b) The `query` tool sends `SELECT * FROM (<sql>) AS _q LIMIT 1000` to a fake pool.
- (c) A request with Host `evil.example` gets 421.
- (d) POST `/mcp` with no bearer gets 401 and a `WWW-Authenticate` header containing `resource_metadata=`.
- (e) A static-key `tools/list` returns exactly `list_tables`, `describe_table`, `query`, with descriptions byte-identical to the strings at `server.mjs:83`, `:105` and `:127–129`.
- (f) `config.mjs` throws when `DB_PASSWORD` is unset or `MCP_API_KEY` is shorter than 32 chars.
**Done-when**: `cd health-mcp && npm ci --silent && npm test`
**Decision rule**: If keeping behavior byte-identical conflicts with the module split, keep the behavior and note the boundary compromise.
**Notes**:

### T2: Integration test database harness and CI job [model: sonnet] [risk: high] [status: todo] [deps: T1]
**Outcome**: `npm run test:integration` builds a throwaway schema in `TEST_DATABASE_URL` two ways, from `schema.sql` (fresh) and from a frozen baseline plus migrations (upgrade), and CI runs the unit and integration suites against a `postgres:18` service.
**Files**: `health-mcp/test/helpers/testdb.mjs` (new), `health-mcp/test/integration/harness.int.test.mjs` (new), `health-mcp/package.json` (add `test:integration`), `health_data_hub/db/baseline/schema_2026-10.sql` (new; byte copy of the current `health_data_hub/db/schema.sql`), `.github/workflows/kit-ci.yml` (add a `node` job)
**Non-goals**: No schema changes. No change to the Python CI job's steps.
**Acceptance tests**: `health-mcp/test/integration/harness.int.test.mjs`:
- (a) The helper throws before connecting when `TEST_DATABASE_URL` is unset, when its database name does not end in `_test`, or when its host is not localhost or 127.0.0.1.
- (b) `resetDb()` drops schemas `public`, `monitoring` and `usda` if present, recreates `public`, ensures role `claude_readonly` exists with `default_transaction_read_only=on` and a known test password, and runs `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO claude_readonly`.
- (c) `freshInstall()` applies `schema.sql`. `upgradeInstall()` applies the baseline, then every `health_data_hub/db/migrations/*.sql` except `*.down.sql`, in lexical order.
- (d) `catalogSnapshot()` (relation kind, columns, types, nullability and grants for `public`) is equal after `freshInstall()` and after `upgradeInstall()`.
- (e) A pool logged in as `claude_readonly` can SELECT `nutrition_daily`, and an INSERT through it fails.

The CI `node` job uses `actions/setup-node` (Node 22), a `postgres:18` service with `POSTGRES_DB=hdh_test`, `npm ci` in `health-mcp`, then `npm test` and `npm run test:integration`. Every tool it runs must be installed by those steps (lesson: kit adoption/CI).
**Done-when**: `cd health-mcp && npm ci --silent && npm test && npm run test:integration`
**Decision rule**: If `schema.sql` fails on a fresh Postgres 18, report needs-decision with the error. Do not edit `schema.sql` in this task.
**Notes**:

### T3: Migration ledger [model: haiku] [risk: high] [status: todo] [deps: T2]
**Outcome**: `public.schema_migrations(name text PK, applied_at timestamptz)` exists after upgrade or fresh install. Re-applying a guarded migration raises.
**Files**: `health_data_hub/db/migrations/2026-11_00_migration_ledger.sql` (new; build-plan §4.1, plus a row for itself), `health_data_hub/db/migrations/2026-11_00_migration_ledger.down.sql` (new), `health_data_hub/db/schema.sql` (append the ledger table and both rows), `health-mcp/test/integration/ledger.int.test.mjs` (new)
**Non-goals**: No other tables. No shell migration runner.
**Acceptance tests**: `health-mcp/test/integration/ledger.int.test.mjs`:
- (a) After `upgradeInstall()`, the ledger holds `2026-10_body_measurements` and `2026-11_00_migration_ledger`.
- (b) A sample guarded migration string run twice raises `already applied` the second time.
- (c) T2's catalog parity still holds.
- (d) The down script drops the table.
**Done-when**: `cd health-mcp && npm ci --silent && npm test && npm run test:integration`
**Decision rule**: The guard pattern written here is the one later migrations copy. Write it as a short comment at the top of the file.
**Notes**:

### T4: food_log, my_foods, audit and nutrition_writer schema [model: sonnet] [risk: high] [status: todo] [deps: T3]
**Outcome**: Migration `01` creates the build-plan §4.2 objects: `pg_trgm`, `touch_updated_at`, `my_foods`, `my_food_aliases`, `food_log` with the generated LA `day`, `food_log_audit` and its trigger, view `food_log_daily`, and role `nutrition_writer` with its grants. `schema.sql` mirrors them.
**Files**: `health_data_hub/db/migrations/2026-11_01_food_log.sql` (new), `health_data_hub/db/migrations/2026-11_01_food_log.down.sql` (new), `health_data_hub/db/schema.sql`, `health-mcp/test/integration/food_log_schema.int.test.mjs` (new), `health-mcp/test/helpers/testdb.mjs` (give `nutrition_writer` a known test password after install)
**Non-goals**: No `nutrition_daily` change, no goals tables, no USDA. No role password in any file except the test helper's.
**Acceptance tests**: `health-mcp/test/integration/food_log_schema.int.test.mjs`:
- (a) `day` is 2026-10-25 for `2026-10-25T23:30-07:00` and 2026-10-26 for `2026-10-26T00:30-07:00`.
- (b) `2026-11-01T01:30-07:00`, `2026-11-01T01:30-08:00` and `2026-11-02T07:59Z` are all 2026-11-01.
- (c) Same as (a) with session `TimeZone='UTC'`.
- (d) CHECKs reject `match_source='favorite'` with NULL `my_food_id`, `match_source='usda'` with NULL `fdc_id`, `calories=-1`, and `meal='brunch'`.
- (e) A duplicate `(request_id, request_line)` is rejected.
- (f) Insert, update, soft delete and restore write audit actions `insert`, `update`, `soft_delete`, `restore`.
- (g) As `nutrition_writer`: INSERT into `food_log` works with no sequence grant; DELETE on `food_log` fails; `UPDATE food_log SET created_via=...` fails; SELECT on `workout_samples` fails.
- (h) As `claude_readonly`: SELECT on `food_log` and `food_log_daily` works; INSERT fails.
- (i) `food_log_daily` excludes soft-deleted rows, and `sum(fiber_g)` is NULL when every item's fiber is NULL.
- (j) The down script raises when `food_log` has rows and drops everything, role included, when it is empty.
- (k) T2's catalog parity holds.

GRANT CONNECT targets `current_database()` through `EXECUTE format(...)`. `CREATE ROLE` is skipped if the role exists.
**Done-when**: `cd health-mcp && npm ci --silent && npm test && npm run test:integration`
**Decision rule**: The DDL in build-plan §4.2 is the spec. If a statement there fails on Postgres 18, make the smallest change that passes and record it in Notes.
**Notes**:

### T5: Writer pool, kill switch, rate limit, auth info [model: sonnet] [risk: high] [status: todo] [deps: T1, T4]
**Outcome**: With `WRITE_TOOLS_ENABLED=true`, the app creates a second pool as `DB_WRITER_USER`/`DB_WRITER_PASSWORD` (max 3), passes `req.auth = {clientId}` (`static_key` for the API key) to tool handlers, and offers a write guard. The guard checks the kill switch, applies a per-process token bucket (`WRITE_RATE_LIMIT_PER_HOUR`, default 120) and emits the audit log line. The server sends §5.1 `instructions` amended per D4.
**Files**: `health-mcp/config.mjs`, `health-mcp/app.mjs`, `health-mcp/db.mjs` (new; pool factory for `read` and `write`), `health-mcp/lib/write-guard.mjs` (new), `health-mcp/test/unit/write-guard.test.mjs` (new)
**Non-goals**: No nutrition tools yet. `query` keeps its pool. `oauth.mjs` is untouched.
**Acceptance tests**: `health-mcp/test/unit/write-guard.test.mjs`:
- (a) With `WRITE_TOOLS_ENABLED` unset, `tools/list` equals T1(e) and no write pool is created.
- (b) With `WRITE_TOOLS_ENABLED=true` and no `DB_WRITER_PASSWORD`, `config.mjs` throws.
- (c) Call N+1 within the window returns `RATE_LIMITED`.
- (d) The guard's log line parses as JSON with keys `evt, tool, client, ids, kcal_delta`, and contains neither the item description nor the bearer token.
- (e) Handlers receive `authInfo.clientId`.

Add to `health-mcp/test/integration/food_log_schema.int.test.mjs`: (f) with both pools configured, the `query` tool's `SELECT current_user AS u` returns `claude_readonly`.
**Done-when**: `cd health-mcp && npm ci --silent && npm test && npm run test:integration`
**Decision rule**: If the MCP SDK does not forward `req.auth` to handlers, pass the client id through a per-request `getServer(ctx)` closure instead and note it.
**Notes**:

### T6: log_food with preview and confirm [model: sonnet] [risk: high] [status: todo] [deps: T5]
**Outcome**: Tool `log_food` per build-plan §5.3 plus D4. Without `confirm` it returns computed rows and projected `day_totals` and writes nothing. With `confirm: true` it inserts all items in one transaction (all or none), honors `request_id` idempotency, bumps favorite `use_count`/`last_used_at`, and returns stored rows, warnings and `day_totals`.
**Files**: `health-mcp/tools/nutrition/common.mjs` (new; zod item schema, LA time resolution, meal inference, NUMERIC conversion, Atwater check), `health-mcp/tools/nutrition/log-food.mjs` (new), `health-mcp/tools/nutrition/index.mjs` (new; registers nutrition tools when writes are enabled), `health-mcp/test/unit/nutrition-common.test.mjs` (new), `health-mcp/test/integration/log_food.int.test.mjs` (new)
**Non-goals**: No USDA computation: `match_source='usda'` requires explicit nutrients and an `fdc_id`. No goals in totals yet.
**Acceptance tests**:

`nutrition-common.test.mjs`:
- (a) `eaten_at` `2026-10-25T08:00` (no offset) resolves to 15:00Z.
- (b) `day=2026-10-24` with `meal=dinner` resolves to 2026-10-24 19:00 LA. Defaults: breakfast 08:00, lunch 12:30, snack 15:30.
- (c) Meal inference: LA 09:00 → breakfast, 13:00 → lunch, 18:00 → dinner.
- (d) A 90-day-old `eaten_at` fails unless `allow_backfill`, and `now+7h` fails.
- (e) Atwater warning when `|4P+4C+9F−kcal| > max(60, 25%)`.
- (f) A 26-item batch is rejected.

`log_food.int.test.mjs`:
- (g) No `confirm`: returns 3 computed rows, and the `food_log` count is unchanged.
- (h) `confirm: true` with 3 items: 3 rows and `day_totals` that match `food_log_daily`.
- (i) An invalid item 2 inserts nothing and returns `VALIDATION_ERROR` with `item_index: 1`.
- (j) The same `request_id` twice gives one set of rows, and the second response has `duplicate: true`.
- (k) A favorite with `servings: 1.5` and no nutrients stores 1.5× the favorite's values, with `computed_by_server: true`.
- (l) An archived or unknown `my_food_id` gives `NOT_FOUND`.
- (m) With `WRITE_TOOLS_ENABLED=false` the tool is absent.
- (n) The tool description contains `confirm` and `confidence`.
**Done-when**: `cd health-mcp && npm ci --silent && npm test && npm run test:integration`
**Decision rule**: When the build-plan §5.3 text and D4 disagree, D4 wins. Any other gap: choose the behavior that writes nothing and returns `VALIDATION_ERROR`, and note it.
**Notes**:

### T7: save_favorite and search_foods (favorites tier) [model: sonnet] [risk: high] [status: todo] [deps: T6]
**Outcome**: `save_favorite` (build-plan §5.4) creates, updates and archives favorites and their aliases in one transaction. `search_foods` (§5.2) runs on the read pool and returns favorites ranked exact alias first, then `word_similarity`, then `use_count`, plus `usda: []` and a note that USDA is not loaded yet.
**Files**: `health-mcp/tools/nutrition/favorites.mjs` (new), `health-mcp/tools/nutrition/search.mjs` (new), `health-mcp/tools/nutrition/index.mjs`, `health-mcp/test/integration/favorites.int.test.mjs` (new)
**Non-goals**: No USDA queries. No `unaccent`.
**Acceptance tests**: `health-mcp/test/integration/favorites.int.test.mjs`:
- (a) Creating "Usual oatmeal" with alias "usual oatmeal" means `search_foods("my usual oatmeal")` returns it first with `exact: true`.
- (b) `search_foods("oatmeal")` returns it with `exact: false` and a score of at least 0.4.
- (c) Saving another favorite with alias "Usual  Oatmeal " gives `CONFLICT` naming the owning `my_food_id`.
- (d) `from_log_id` copies nutrients and serving from that `food_log` row.
- (e) `archive: true` removes it from search results and frees its aliases.
- (f) The `search_foods` handler runs on the read pool (asserted with a pool spy).
- (g) The favorite name is always stored as an alias.
**Done-when**: `cd health-mcp && npm ci --silent && npm test && npm run test:integration`
**Decision rule**: The filler words stripped for the second query variant are exactly `my, usual, regular, normal, the`. Do not add more without a needs-decision.
**Notes**:

### T8: Goals, day status and the nutrition_daily view [model: opus] [risk: high] [status: todo] [deps: T4]
**Outcome**: Migration `02` creates `nutrition_goals` per D5 with its seed row, `nutrition_day_status`, renames the table to `nutrition_daily_legacy` (and its PK index), and creates VIEW `nutrition_daily` per D2 and build-plan §4.3, with goal columns per D5. `schema.sql` produces the same end state, and its `ALTER TABLE nutrition_daily ADD COLUMN` line targets `nutrition_daily_legacy`.
**Files**: `health_data_hub/db/migrations/2026-11_02_nutrition_daily_view.sql` (new), `health_data_hub/db/migrations/2026-11_02_nutrition_daily_view.down.sql` (new), `health_data_hub/db/schema.sql`, `health-mcp/test/integration/nutrition_daily_view.int.test.mjs` (new), `health-mcp/test/fixtures/nutrition_daily_rows.sql` (new; about 10 synthetic rows covering the `myfitnesspal` source with `meals_json` and goals, the `apple_health` source, and all-NULL rows)
**Non-goals**: No tool changes. No deletion of legacy rows (A2). No reader code changes.
**Acceptance tests**: `health-mcp/test/integration/nutrition_daily_view.int.test.mjs`:
- (a) On the baseline plus fixture with an empty `food_log`, `SELECT *, pg_typeof(...)` of every column `FROM nutrition_daily ORDER BY day` is identical before and after the migration.
- (b) After `food_log` rows on a fixture legacy day, that day returns `source='food_log'` and the `food_log` sums, not the sum of both.
- (c) Soft-deleting those rows brings the legacy row back.
- (d) `meals_json` keys come only from `breakfast, lunch, dinner, snacks`.
- (e) Goal with the seed row: a day with two `Ride` rows (`device_watts` true, kj 400 and 250), one `EBikeRide` (kj 300, `device_watts` false) and one `Ride` with kj NULL gives `goal_calories` 3270. A day with no rides gives 2620. `goal_protein_g` is 180. `pg_get_viewdef('nutrition_daily')` does not contain `oura`.
- (f) `logged_complete` comes from `nutrition_day_status` for `food_log` days.
- (g) `init_db`-equivalent: `freshInstall()` twice in a row succeeds.
- (h) T2's catalog parity holds.
- (i) The down script restores table `nutrition_daily`, and (a) passes again.
- (j) `claude_readonly` can SELECT the view and `nutrition_daily_legacy`.
**Done-when**: `cd health-mcp && npm ci --silent && npm test && npm run test:integration`
**Decision rule**: Column types must equal the legacy table's (`calories int`, `*_g double precision`, `weight_kg numeric(5,2)`). If a cast choice is unclear, match `pg_typeof` of the legacy column.
**Notes**:

### T9: get_day_summary, update/delete entries, mark_day_complete [model: sonnet] [risk: high] [status: todo] [deps: T7, T8]
**Outcome**: These tools exist:
- `get_day_summary` (§5.7, read pool): defaults to today in LA, returns goals and remaining calories from `nutrition_daily`, plus latest weight and `kg_to_target` per D5.
- `update_log_entry` (§5.5).
- `delete_log_entry` with `restore` (§5.6).
- `mark_day_complete` (§5.8).

The three write tools go through the T5 write guard.
**Files**: `health-mcp/tools/nutrition/summary.mjs` (new), `health-mcp/tools/nutrition/edit.mjs` (new), `health-mcp/tools/nutrition/index.mjs`, `health-mcp/test/integration/summary_edit.int.test.mjs` (new)
**Non-goals**: No USDA recompute. No hard deletes.
**Acceptance tests**: `health-mcp/test/integration/summary_edit.int.test.mjs`:
- (a) With the clock frozen at `2026-10-25T23:30-07:00`, the default day is 2026-10-25.
- (b) Items are ordered by `eaten_at` and carry their ids. Soft-deleted items are absent.
- (c) A legacy-only day returns `source: "legacy"` and a `note`.
- (d) `kg_to_target` = latest `body_weight_daily.weight_kg` − 100, and `cycling_kcal` equals the D5 sum for that day.
- (e) Updating a favorite entry's `servings` from 1 to 2 with no nutrients doubles its nutrients and writes one `update` audit row.
- (f) Moving an entry's `day` returns `day_totals` for both days.
- (g) Updating a deleted entry gives `ALREADY_DELETED`.
- (h) Deleting `[id, 999999]` gives `NOT_FOUND` and changes nothing. Deleting twice reports `unchanged`. `restore: true` brings the entry back.
- (i) `mark_day_complete` sets `nutrition_daily.logged_complete` for that day.
- (j) The `delete_log_entry` description asks for confirmation before deleting more than 3 items.
**Done-when**: `cd health-mcp && npm ci --silent && npm test && npm run test:integration`
**Decision rule**: Patch fields not listed in build-plan §5.5 are rejected with `VALIDATION_ERROR`, not ignored.
**Notes**:

### T10: Retire the Apple Health nutrition poller [model: sonnet] [risk: normal] [status: todo] [deps: none]
**Outcome**: `scheduler_all.py` no longer imports or schedules the nutrition poller. `nutrition_poller.py`, `insert_nutrition_daily.py` and `lock_nutrition.py` live under `archive/` with an ARCHIVED.md entry dated 2026-10-25 citing D1.
**Files**: `scheduler_all.py` (remove the lines at :45, :100–106 and the `add_job` block at :160–167, and update the docstring job list), `archive/ARCHIVED.md` (copy the entry format at :41), `archive/nutrition_poller.py` (git mv), `archive/insert_nutrition_daily.py` (git mv), `archive/lock_nutrition.py` (git mv)
**Non-goals**: No change to `nutrition_reader.py`, the Worker, or other jobs.
**Acceptance tests**: none: removal and moves. Done-when proves the import is gone, the module compiles and the suite passes.
**Done-when**: `venv/Scripts/python -m py_compile scheduler_all.py && ! grep -rq --include='*.py' 'nutrition_poller\|insert_nutrition_daily' scheduler_all.py health_data_hub && test -f archive/lock_nutrition.py && test ! -f lock_nutrition.py && venv/Scripts/python -m pytest -q`
**Decision rule**: If any non-archived module still imports a moved file, report needs-decision rather than moving more files.
**Notes**:

### T11: Nutrition quality checks follow food_log [model: haiku] [risk: normal] [status: todo] [deps: none]
**Outcome**: `_nutrition_checks()` replaces the `nutrition_daily` freshness check (180 min) with `FreshnessCheck("food_log", "created_at", max_age_minutes=1440, severity="warn")` and adds `ValueRangeCheck("food_log_daily", "calories", 0, 8000)`. The `nutrition_daily` NullCheck and RowCountCheck stay.
**Files**: `health_data_hub/quality/checks_health.py` (edit at :124), `tests/test_nutrition_checks.py` (new; copy the pattern in `tests/test_body_freshness.py`)
**Non-goals**: No change to `checks.py` or other check groups.
**Acceptance tests**: `tests/test_nutrition_checks.py`:
- (a) `_nutrition_checks()` contains a FreshnessCheck on `food_log.created_at` with 1440 min and severity `warn`.
- (b) It has no FreshnessCheck on `nutrition_daily`.
- (c) It contains a ValueRangeCheck on `food_log_daily.calories` with bounds 0–8000.
- (d) A FakeConn returning a `created_at` 25 h old makes the freshness check fail.
**Done-when**: `venv/Scripts/python -m pytest -q tests/test_nutrition_checks.py && venv/Scripts/python -m pytest -q`
**Decision rule**: Keep check names in the existing `freshness_<table>` form.
**Notes**:

### T12: Consent text, README, user guide and deploy runbook [model: sonnet] [risk: high] [status: todo] [deps: T9, T10]
**Outcome**:
- The OAuth consent page says the app "is requesting access to read your health data and log food".
- `health-mcp/README.md` documents the 7 new tools, the `nutrition_writer` role, the new env vars, the write guards, and the corrected data model (sources MFP and Apple Health, not Cronometer).
- `docs/nutrition_logging.md` gives the D4 confirm-first conversation flow for text, photo, corrections and favorites, plus the confidence rubric from build-plan §5.1.
- `docs/nutrition_deploy_runbook.md` lists the live steps in order:
  1. `pg_dump -Fc` and an off-Pi copy
  2. apply migrations 00–02 with `psql -v ON_ERROR_STOP=1 --single-transaction -f`
  3. set the `nutrition_writer` password
  4. add `DB_WRITER_*` and `WRITE_TOOLS_ENABLED=true` to `health-mcp.env`
  5. deploy the code and restart `health-mcp` and `health-data-hub`
  6. turn off the HAE nutrition export
  7. the end-to-end checklist from build-plan T1.6 and T2.3
  8. the rollback ladder from build-plan §10
**Files**: `health-mcp/oauth.mjs` (consent string at :127 only), `health-mcp/README.md`, `docs/nutrition_logging.md` (new), `docs/nutrition_deploy_runbook.md` (new), `health-mcp/test/unit/consent.test.mjs` (new)
**Non-goals**: No OAuth logic change (token lifetimes, storage, scopes).
**Acceptance tests**: `health-mcp/test/unit/consent.test.mjs`:
- (a) GET `/authorize` for a registered client renders "log food" and no longer contains "read-only access".
- (b) PKCE and redirect checks still return 400 on a missing `code_challenge`.
**Done-when**: `cd health-mcp && npm ci --silent && npm test && grep -q 'nutrition_writer' README.md && grep -q 'confirm' ../docs/nutrition_logging.md && grep -q 'pg_dump' ../docs/nutrition_deploy_runbook.md && grep -q 'ON_ERROR_STOP' ../docs/nutrition_deploy_runbook.md`
**Decision rule**: The runbook states only steps derivable from this plan, the build plan and `health-mcp/README.md`. Do not invent host names or paths.
**Notes**:

### T13: Promote the never-raise job lesson to a test [model: haiku] [risk: normal] [status: todo] [deps: T10]
**Outcome**: A pytest test fails if any `run_*` job wrapper in `scheduler_all.py` lacks an `except Exception` handler. The lesson line ("catch-all `except Exception`", count 2) is deleted from LESSONS.md.
**Files**: `tests/test_scheduler_wrappers.py` (new; parse `scheduler_all.py` with `ast`, no import), `LESSONS.md` (delete that one line)
**Non-goals**: No changes to pollers or `scheduler_all.py`.
**Acceptance tests**: `tests/test_scheduler_wrappers.py`:
- (a) Every top-level `def run_*` in `scheduler_all.py` contains a `Try` node whose handlers include `except Exception`.
- (b) The test fails on an in-memory source string whose `run_x` catches only `ValueError` (checked with a helper that takes source text).
**Done-when**: `venv/Scripts/python -m pytest -q tests/test_scheduler_wrappers.py && ! grep -q 'catch-all .except Exception' LESSONS.md && venv/Scripts/python -m pytest -q`
**Decision rule**: If LESSONS.md in the base has no such line (A5 not met), still add the test and note that the line was absent.
**Notes**:
