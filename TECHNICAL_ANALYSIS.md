# Health Data Hub — Technical Analysis & Build Documentation

> **Purpose of this document:** Full reverse-engineering and architecture reference for the health_data_hub personal health analytics platform. Suitable for technical interviews, knowledge-base entries, or onboarding a co-contributor.

---

## SECTION 1: Component Inventory

### 1A. Backend Services / Polling Daemons

| Service | File | Trigger | Primary Logic |
|---|---|---|---|
| Strava Poller | `health_data_hub/integrations/poll_strava.py` | Every 5 min (APScheduler) | Fetch last 30 activities → insert raw + streams → compute NP/IF/TSS → sync Notion |
| Oura Poller | `health_data_hub/integrations/oura/poll_oura.py` | Daily at configurable hour | Fetch sleep/readiness/HR (3d back) + activity (1d back) → extract → upsert 4 tables |
| Notion State Poller | `health_data_hub/integrations/notion/poll_notion_daily_state.py` | Daily at configurable hour | Query Notion Daily Physical State DB → extract records → upsert daily_physical_state |
| MFP Poller | `health_data_hub/integrations/mfp/poll_mfp.py` | Daily at configurable hour | Fetch N days nutrition → extract macros → upsert nutrition_daily |
| Unified Scheduler | `scheduler_all.py` | Process entrypoint | APScheduler coordinator — dispatches all 4 pollers with per-job max_instances=1 |
| Simple Strava Scheduler | `scheduler.py` | Process entrypoint (legacy) | APScheduler, Strava-only, 5-min interval |

### 1B. ETL — Extract Layer

| Module | Key Functions | Input | Output |
|---|---|---|---|
| `etl/extract/strava_api.py` | `get_recent_activities(token, limit=10)`, `get_all_strava_activities(token, after=None)`, `get_activity_streams(token, activity_id)` | Strava access token | List of activity dicts / stream dict |
| `etl/extract/strava_oauth.py` | `run_oauth()` | Browser redirect on localhost:8000 | Writes tokens to `strava_tokens.json` |
| `etl/extract/strava_refresh.py` | `get_valid_access_token()` | `strava_tokens.json` | Valid access token (refreshes if <5 min remaining; atomic file write via temp+rename) |
| `etl/extract/oura_extract.py` | `extract_sleep_records()`, `extract_readiness_records()`, `extract_hr_samples()`, `extract_activity_records()` | Oura API JSON | List of row dicts ready for insert |
| `etl/extract/mfp_extract.py` | `extract_daily_nutrition(day_obj, target_date, weight_kg)` | MFP Day object | nutrition_daily row dict with meals_json JSONB |
| `etl/extract/notion_daily_state_extract.py` | `extract_daily_state_records(pages)` | Notion page objects | List of daily_physical_state row dicts |

### 1C. ETL — Load Layer

| Module | Function | Upsert Key | Idempotency |
|---|---|---|---|
| `etl/load/insert_workout.py` | `insert_workout_metadata(activity)` | `external_id` | ON CONFLICT DO UPDATE |
| `etl/load/insert_workout_samples.py` | `insert_workout_samples(workout_id, streams)` | workout_id | DELETE + re-insert |
| `etl/load/insert_oura_sleep.py` | `insert_oura_sleep(conn, rows)` | `sleep_id` | ON CONFLICT DO UPDATE |
| `etl/load/insert_oura_readiness.py` | `insert_oura_readiness(conn, rows)` | `day` | ON CONFLICT DO UPDATE |
| `etl/load/insert_oura_hr.py` | `insert_oura_hr(conn, rows)` | `(sleep_id, timestamp)` | ON CONFLICT DO UPDATE |
| `etl/load/insert_oura_activity.py` | `insert_oura_activity(conn, rows)` | `day` | ON CONFLICT DO UPDATE |
| `etl/load/insert_daily_physical_state.py` | `insert_daily_physical_state(conn, rows)` | `day` | ON CONFLICT DO UPDATE |
| `etl/load/insert_nutrition_daily.py` | `insert_nutrition_daily(conn, rows)` | `day` | ON CONFLICT DO UPDATE |

### 1D. ETL — Transform Layer

| Module | Function | Algorithm |
|---|---|---|
| `etl/transform/build_workout_summary.py` | `build_summary_for(workout_id)`, `_compute_np_if_tss(watts, ftp, moving_s)` | 30-sec rolling avg → 4th power → mean → 4th root = Normalized Power; IF = NP/FTP; TSS = (sec × NP × IF)/(FTP × 3600) × 100 |
| `etl/transform/build_all_summaries.py` | `build_all_summaries()` | Loops all workouts, calls `build_summary_for()` per workout |
| `etl/transform/backfill_strava.py` | `backfill_all()` | `backfill_metadata()` → `backfill_streams()` → `insert_stream_samples()` since 2022-01-01 |

### 1E. Analysis Scripts (AI-Powered)

| Script | Model | Context Window | Output |
|---|---|---|---|
| `morning_briefing.py` | Claude Opus 4.5 | 4-day daily rollup JSON | Body state, fatigue flags, nutrition vs deficit target, today's calorie target |
| `analyze_training.py` | Claude Opus 4.6 | 7-day + 90-day training data | PMC status, load balance, sleep/HRV, nutrition, w/kg trend, recommendations |
| `weekly_plan.py` | Claude Opus 4.5 | 14-day + 90-day context | Week in numbers (CTL/TSB/sleep/deficit/weight), recovery analysis, nutrition adherence, planned next week |

### 1F. Notion Reporter (Node.js Subsystem)

| File | Purpose |
|---|---|
| `notion-reporter/index.mjs` | Entry point — routes `REPORT_MODE={daily,weekly,dry}` to context builders → Claude → Notion post |
| `notion-reporter/src/utils/buildDailyContext.mjs` | Queries PostgreSQL, assembles today + 3-night window, resolves Notion page refs |
| `notion-reporter/src/utils/buildWeeklyContext.mjs` | Queries PostgreSQL for 14-day + 90-day window, includes planned_workouts, deficit adherence string |
| `notion-reporter/src/utils/db.mjs` | pg connection pool with `closePool()` for graceful shutdown |
| `notion-reporter/src/anthropic/analyzeHealth.mjs` | Calls Anthropic SDK with system prompt + context, returns markdown analysis |
| `notion-reporter/src/notion/postReport.mjs` | Creates structured Notion page with blocks (headings, paragraphs, callouts) |

### 1G. Databases & Data Models

**PostgreSQL (local, db=health)**

| Table | Rows (baseline) | Primary Key | Description |
|---|---|---|---|
| `workouts_raw` | 806 | SERIAL id, UNIQUE external_id | Strava activity metadata (sport, distance, time, speed, cadence, HR, watts, elevation) |
| `workout_samples` | 1.79M | BIGSERIAL id | Second-by-second streams (heartrate, cadence, watts, velocity_mps) per workout |
| `workout_summary` | 806 | workout_id FK | Computed NP, IF, TSS joined with raw metadata |
| `oura_sleep_raw` | 200 | BIGSERIAL id, UNIQUE sleep_id | Sleep phases (deep/light/REM/awake), HR, HRV, efficiency, latency |
| `oura_readiness_raw` | 150 | BIGSERIAL id, UNIQUE day | Daily readiness score + 9 contributor metrics |
| `oura_hr_samples` | 14,912 | BIGSERIAL id, UNIQUE (sleep_id, ts) | 5-min HR/HRV samples from sleep sensor |
| `oura_activity_raw` | 149 | BIGSERIAL id, UNIQUE day | Steps, active/total calories, MET-minutes by zone |
| `daily_physical_state` | — | day PK | Subjective state from Notion (overall_state, energy_level, body_signals[], notes) |
| `nutrition_daily` | — | day PK | Calories, macros, goals, meals_json JSONB from MyFitnessPal |
| `planned_workouts` | — | SERIAL id, UNIQUE (planned_date, class_type) | Training calendar (class_type, duration_min, estimated_tss) |
| `ftp_history` | — | SERIAL id | FTP wattage by effective_from date (used for per-workout TSS lookup) |
| `test_raw` | — | — | Test fixture table |

**Key Views:**
- `notion_workouts_view` — normalized workout data for Notion sync (unit-converted: m/s→mph, m→miles, MET-style device tag)
- `analysis_daily_rollup_10d` — 10-day rolling dashboard: training hours, TSS, sleep score, readiness, HRV, CTL/ATL/TSB via recursive CTE EMA

### 1H. Utilities & Helpers

| Module | Function | I/O |
|---|---|---|
| `utils/db_connect.py` | `get_connection()` | Returns `psycopg2.connection` using settings |
| `utils/logging_config.py` | `setup_logging(level=INFO)` | Configures root logger to stdout; idempotent |
| `etl/export_daily_json.py` | `export_daily_json(start, end) → dict` | 20-table LEFT JOIN + recursive CTEs for CTL/ATL/TSB export |
| `etl/init_db.py` | `initialize_database()` | Reads schema.sql, executes idempotent DDL |
| `etl/import_planned_workouts.py` | `import_planned_workouts(csv_path)` | CSV → validated rows → upsert planned_workouts |
| `run_all.py` | `main()` | init_db → backfill_all → build_all_summaries (one-time setup) |

### 1I. Configuration & Environment

| File | Purpose |
|---|---|
| `health_data_hub/config/settings.py` | Central config loader — reads `HEALTH_ENV` → loads `{dev,prod,test}.env`, exports all credentials |
| `health_data_hub/config/dev.env` | Development secrets (DB, Strava, Notion, Oura, Anthropic, MFP) |
| `health_data_hub/config/prod.env` | Production secrets |
| `health_data_hub/config/test.env` | Dummy test values (safe to commit) |
| `health_data_hub/config/strava_tokens.json` | OAuth token store (access + refresh + expiry) |
| `health_data_hub/config/mfp_cookies.txt` | MFP session cookies for cookie-based auth |
| `notion-reporter/.env` | Node.js env file (DB credentials, Anthropic key, Notion token) |
| `requirements.txt` | Python deps: psycopg2-binary, anthropic, requests, python-dotenv, notion-client, numpy, apscheduler, pytest, myfitnesspal |
| `notion-reporter/package.json` | Node deps: @anthropic-ai/sdk, @notionhq/client, pg, dotenv, cross-env |

**Environment Variables:**
```
HEALTH_ENV          # dev | prod | test
DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REDIRECT_URI, STRAVA_SCOPE
NOTION_TOKEN, NOTION_WORKOUT_DB_ID, NOTION_DAILY_STATE_DB_ID
OURA_PERSONAL_ACCESS_TOKEN
ANTHROPIC_API_KEY
MFP_USERNAME
STRAVA_POLL_INTERVAL_MIN  # default 5
OURA_POLL_HOUR            # default 7
NOTION_DAILY_STATE_POLL_HOUR  # default 8
MFP_POLL_HOUR             # default 23
NOTION_DRY_RUN            # 1 = skip Notion writes
```

### 1J. Third-Party Integrations

| Service | Library/Protocol | How Used | Key Features Leveraged |
|---|---|---|---|
| Strava | REST API v3 + OAuth 2.0 | Poll activities + stream data | Paginated activity list, per-activity stream (watts, HR, cadence, latlng, time) |
| Oura Ring v2 | REST API + Personal Access Token | Daily sleep, readiness, activity | `/usercollection/sleep`, `/usercollection/daily_activity` |
| Notion | Official SDK (`notion-client` / `@notionhq/client`) | Workout sync, daily state read, report posting | Database query w/ filter, page create/update, block children append |
| MyFitnessPal | Unofficial `myfitnesspal` Python library + cookies | Daily nutrition logging | Day-level totals, macro breakdown, meal-level detail |
| Anthropic Claude | `anthropic` Python SDK + `@anthropic-ai/sdk` Node.js | Morning briefing, training analysis, weekly plan, Notion report | `messages.create`, system prompt, multi-turn context, Opus 4.5/4.6 |
| PostgreSQL | `psycopg2` (Python) + `pg` (Node.js) | Central data store | UPSERT (ON CONFLICT DO UPDATE), JSONB columns, CTEs, views |
| APScheduler | `apscheduler` | Polling daemon | BlockingScheduler, IntervalTrigger, CronTrigger, max_instances |

### 1K. Testing & Quality Assurance

| File | Framework | Coverage Area |
|---|---|---|
| `tests/conftest.py` | pytest | Sets `HEALTH_ENV=test` before any imports — ensures test.env loads, no real DB/API |
| `tests/test_compute_metrics.py` | pytest (pure logic) | NP/IF/TSS algorithm: edge cases (empty, <30 pts, None FTP, None values), correctness (constant power, IF=1@FTP, TSS=100 for 1hr@FTP, duration scaling) — 11 tests |
| `tests/test_oura_extract.py` | pytest (pure logic) | Oura extraction transformations |
| `tests/test_strava_utils.py` | pytest (pure logic) | Strava utility functions |

**Test design philosophy:** All tests are database-free and API-free pure logic tests. Integration testing is manual (rerun pollers, check DB row counts).

---

## SECTION 2: Build Task List (Reverse Order)

*Ordered from "deployed running system" back to "empty directory." Each task is what you'd undo or rebuild last→first.*

---

**Task 1: Notion Intelligence Reporter (Node.js) — Implement**
Priority: High | Complexity: High
Dependencies: Tasks 2, 3, 4, 8, 9
Description: The most recent subsystem. A standalone Node.js ES module that queries PostgreSQL, calls Claude (Anthropic SDK), and posts structured reports to Notion. Separate from the Python stack to leverage the official Anthropic JS SDK and avoid context limits when composing rich Notion blocks.
Acceptance Criteria:
- `REPORT_MODE=daily` posts morning briefing as Notion page with blocks
- `REPORT_MODE=weekly` posts Sunday review with 14-day + 90-day context
- `REPORT_MODE=dry` prints assembled prompt without any API calls
- Pool is closed gracefully via `.finally(() => closePool())`

---

**Task 2: AI Analysis Scripts (Python) — Implement**
Priority: High | Complexity: Medium
Dependencies: Tasks 4, 8, 9
Description: Three Python scripts (`morning_briefing.py`, `analyze_training.py`, `weekly_plan.py`) that call `export_daily_json()` for context windows and invoke Claude with sport-science-aware system prompts. The prompts encode the athlete's goal (lose 27kg, preserve cycling power, track w/kg).
Acceptance Criteria:
- `morning_briefing.py` outputs: body state, fatigue flags, nutrition vs deficit, today's calorie target
- `analyze_training.py` outputs: PMC status, w/kg trend, 7d + 90d views
- `weekly_plan.py` outputs: week in numbers, recovery state, deficit adherence, next week plan
- All save to `analysis_logs/YYYY-MM-DD.txt` unless `--no-save`

---

**Task 3: Unified Scheduler — Implement**
Priority: High | Complexity: Medium
Dependencies: Tasks 5, 6, 7
Description: `scheduler_all.py` using APScheduler to coordinate all 4 pollers with independent schedules (Strava 5-min interval; Oura, Notion, MFP daily cron). `max_instances=1` prevents job pile-up if a slow poll overlaps the next trigger.
Acceptance Criteria:
- Each job runs on its own schedule without blocking others
- Job failures are caught per-job and logged (other jobs continue)
- All schedule hours configurable via env vars

---

**Task 4: Export + PMC Data Layer — Implement**
Priority: Critical | Complexity: High
Dependencies: Task 9, 10
Description: `etl/export_daily_json.py` — the central data aggregation function. Runs a 20-table LEFT JOIN with a recursive CTE that computes CTL (42-day EMA), ATL (7-day EMA), and TSB = CTL − ATL. This is the single source of truth for all AI context windows.
Acceptance Criteria:
- Returns unified JSON keyed by date with sleep, readiness, activity, HR, workouts, nutrition, PMC
- CTL/ATL/TSB computed correctly via recursive SQL CTE
- Works for arbitrary date ranges; handles missing data via LEFT JOINs

---

**Task 5: MyFitnessPal Integration — Implement**
Priority: Medium | Complexity: High
Dependencies: Tasks 9, 11
Description: MFP integration is the most complex auth-wise. Uses unofficial `myfitnesspal` library with a two-tier strategy: cookie file (production) → browser-cookie3 live fallback (Windows dev). Polled daily; CSV import as backup for API failures.
Acceptance Criteria:
- `poll_mfp.py` correctly upserts N days of nutrition data
- `mfp_auth.py` loads cookie file if present; falls back to browser_cookie3
- Per-day errors handled gracefully (one bad day doesn't stop the batch)
- `import_mfp_csv.py` works as fallback when API is unavailable

---

**Task 6: Notion Integration — Implement**
Priority: High | Complexity: Medium
Dependencies: Tasks 9, 10
Description: Two Notion integrations: (1) `notion_strava_sync.py` — reads from `notion_workouts_view` and writes/updates workout pages; (2) `poll_notion_daily_state.py` — reads athlete's manually entered daily physical state back into the DB. The bidirectional flow (DB→Notion and Notion→DB) is architecturally notable.
Acceptance Criteria:
- Workouts sync correctly with proper unit conversion (m→miles, m/s→mph)
- Device tag inferred from elevation (0 elevation → Peloton, >0 → Garmin)
- `NOTION_DRY_RUN=1` disables all writes for testing
- Daily state pages read back correctly with pagination support

---

**Task 7: Oura Ring Integration — Implement**
Priority: High | Complexity: Medium
Dependencies: Tasks 9, 11
Description: Full Oura v2 API integration across 4 data types. Personal Access Token auth (simpler than Strava OAuth). Key challenge: HR/HRV samples are nested inside sleep records and require flattening into a separate table keyed by `(sleep_id, timestamp)`.
Acceptance Criteria:
- All 4 tables populated: sleep, readiness, hr_samples, activity
- HR samples correctly flattened from nested sleep JSON
- Backfill script handles 60-day history with polite rate limiting
- `poll_oura.py` returns exit code 0/1 for scripting integration

---

**Task 8: Strava Integration — Implement**
Priority: Critical | Complexity: High
Dependencies: Tasks 9, 11, 12
Description: Most complex integration. OAuth 2.0 flow, token refresh with 5-hour buffer and atomic write, paginated backfill since 2022-01-01, second-by-second stream data (1.79M rows), and NP/IF/TSS computation referencing FTP history. The `notion_workouts_view` bridges Postgres to Notion.
Acceptance Criteria:
- OAuth flow works end-to-end (browser redirect → token save)
- Token refresh only triggers when <5 min remaining (5-hour buffer on 6-hour tokens)
- Full backfill loads all activities + streams since 2022
- NP/IF/TSS correctly computed per workout using active FTP at that date

---

**Task 9: Database Schema & Views — Implement**
Priority: Critical | Complexity: Medium
Dependencies: Task 10
Description: Full PostgreSQL schema: 11 tables, 2 views, 3 indexes. `IF NOT EXISTS` / `OR REPLACE` throughout for idempotency. `notion_workouts_view` for Notion sync. `analysis_daily_rollup_10d` for dashboard queries. `ftp_history` for TSS lookups.
Acceptance Criteria:
- `python run_all.py` initializes schema without errors on fresh DB
- All upsert keys defined as UNIQUE constraints
- Views computed correctly
- Recursive CTE in rollup view produces correct CTL/ATL/TSB

---

**Task 10: Core Infrastructure — Implement**
Priority: Critical | Complexity: Low
Dependencies: None
Description: Project scaffolding: Python package structure, `settings.py` for multi-env config loading, `db_connect.py`, `logging_config.py`, virtual environment, `.gitignore`.
Acceptance Criteria:
- `HEALTH_ENV=dev|prod|test` routes to correct `.env` file
- `get_connection()` returns working psycopg2 connection
- `setup_logging()` is idempotent and used by all modules via `logging.getLogger(__name__)`
- `venv/Scripts/python` runs correctly on Windows

---

**Task 11: Compute Metrics Validation — Test**
Priority: High | Complexity: Low
Dependencies: Task 8
Description: Pure-logic pytest suite for NP/IF/TSS. Tests cover algorithm invariants (constant power NP = input, 1hr@FTP = 100 TSS, IF=1@FTP) and edge cases (empty series, <30 samples, None FTP, None watts). Designed to run on CI with zero external dependencies.
Acceptance Criteria:
- All 11 tests pass with `pytest tests/test_compute_metrics.py`
- No DB or API calls required
- `conftest.py` sets `HEALTH_ENV=test` before any imports

---

**Task 12: Strava OAuth Bootstrap — Configure**
Priority: Critical | Complexity: Low
Dependencies: Task 10
Description: One-time OAuth flow to obtain initial Strava tokens. Must be run interactively (browser redirect on localhost:8000). After initial setup, `strava_refresh.py` handles all subsequent refreshes automatically.
Acceptance Criteria:
- `python -m health_data_hub.etl.extract.strava_oauth` opens browser
- Handles callback, saves access_token, refresh_token, expires_at to JSON
- Subsequent polls use `get_valid_access_token()` without manual intervention

---

## SECTION 3: Enterprise Build Summary

### Executive Summary

**What it does:** Health Data Hub is a personal health intelligence platform that ingests biometric and training data from 4 sources (Strava, Oura Ring, Notion, MyFitnessPal), stores it in a normalized PostgreSQL database, computes sports-science performance metrics (Normalized Power, Intensity Factor, Training Stress Score, CTL/ATL/TSB), and generates AI-powered daily briefings and weekly analyses using Claude.

**Business value:** Provides an athlete with a unified view of physical readiness, training load, and nutrition in one system. The AI layer transforms raw numbers into actionable insight: "Is today a good day to push hard?" or "Am I recovering fast enough while in a caloric deficit?" Supports a specific athletic goal: lose 27 kg while preserving cycling power-to-weight ratio (w/kg).

**Technology stack at a glance:**
- Python 3.x (ETL, polling, AI analysis)
- Node.js ES modules (Notion reporter subsystem)
- PostgreSQL 14+ (central data store)
- Anthropic Claude Opus 4.5/4.6 (AI analysis)
- APScheduler (polling daemon)
- 4 external APIs: Strava, Oura, Notion, MyFitnessPal

**Team:** Solo developer / personal project

---

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Data Sources (External)                   │
│  Strava API   Oura Ring API   MyFitnessPal   Notion DB       │
└──────┬──────────────┬──────────────┬─────────────┬──────────┘
       │              │              │             │
       ▼              ▼              ▼             ▼
┌─────────────────────────────────────────────────────────────┐
│                 Polling Layer (scheduler_all.py)             │
│  poll_strava  poll_oura  poll_mfp  poll_notion_daily_state   │
│  (5-min)      (7am daily) (11pm)   (8am daily)               │
└──────────────────────────┬──────────────────────────────────┘
                           │  Extract → Transform → Load
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    PostgreSQL (db=health)                     │
│  workouts_raw    workout_samples    workout_summary           │
│  oura_sleep_raw  oura_readiness_raw  oura_hr_samples          │
│  oura_activity_raw  daily_physical_state  nutrition_daily     │
│  planned_workouts   ftp_history                               │
│  ── Views ──────────────────────────────────────────────     │
│  notion_workouts_view    analysis_daily_rollup_10d            │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────┐    ┌─────────────────────────────────┐
│  Python AI Scripts  │    │   Node.js Notion Reporter        │
│  morning_briefing   │    │   buildDailyContext               │
│  analyze_training   │    │   buildWeeklyContext              │
│  weekly_plan        │    │   analyzeHealth (Anthropic SDK)   │
│  (Anthropic Python) │    │   postReport (Notion SDK)         │
└──────────┬──────────┘    └──────────────┬──────────────────┘
           │                              │
           ▼                              ▼
    analysis_logs/              Notion Pages (DB entries)
    *.txt files
```

**Key design patterns:**
1. **Idempotent ETL** — Every load function uses `ON CONFLICT DO UPDATE`. Safe to rerun any poller at any time.
2. **Raw JSON archiving** — All API responses stored as JSONB columns, enabling re-extraction without re-fetching.
3. **Environment-isolated config** — `HEALTH_ENV` variable routes to different `.env` files. Tests run with zero real credentials.
4. **Layered ETL modules** — `extract/` → `transform/` → `load/` separation. Each layer independently testable.
5. **View-as-API** — `notion_workouts_view` decouples the Notion sync from internal table structure.
6. **CTE-based analytics** — CTL/ATL/TSB computed in pure SQL via recursive CTEs, no application-layer math needed.
7. **Multi-runtime architecture** — Python for ETL/polling (mature data libraries), Node.js for Notion intelligence reports (best-in-class Anthropic + Notion SDKs).

---

### Component Deep Dives

#### NP/IF/TSS Algorithm (`etl/transform/build_workout_summary.py`)

The core sports-science calculation. Training Stress Score (TSS) requires Normalized Power (NP), which accounts for the non-linear physiological cost of variable-intensity efforts.

```python
# Pseudocode of _compute_np_if_tss()
watts = [w or 0.0 for w in watts_series]           # null-to-zero
rolling_30s = rolling_mean(watts, window=30)        # 30-sec smoothing
np = (mean(x**4 for x in rolling_30s)) ** 0.25    # 4th power mean, 4th root
if_val = np / ftp_watts                             # Intensity Factor
tss = (duration_s * np * if_val) / (ftp_watts * 3600) * 100
```

**Why 4th power:** Physiological cost of cycling power is non-linear — doubling power costs ~4× the energy. NP models this to produce a "physiologically equivalent steady-state power" for variable efforts.

**FTP lookup:** `SELECT ftp_watts FROM ftp_history WHERE effective_from <= workout_date ORDER BY effective_from DESC LIMIT 1` — always uses the FTP that was current on that workout's date.

**Performance:** ~1ms per workout. Computed at insert time, stored in `workout_summary` — never recomputed at query time.

#### CTL/ATL/TSB Recursive CTE (`db/schema.sql`)

```sql
-- Exponential moving average for CTL (42-day) and ATL (7-day)
WITH RECURSIVE pmc AS (
  SELECT day, tss, tss AS ctl, tss AS atl FROM ranked WHERE rn = 1
  UNION ALL
  SELECT r.day, r.tss,
    p.ctl * (1 - 1.0/42) + r.tss * (1.0/42),   -- CTL = 42-day EMA
    p.atl * (1 - 1.0/7)  + r.tss * (1.0/7)     -- ATL = 7-day EMA
  FROM ranked r JOIN pmc p ON r.rn = p.rn + 1
)
SELECT day, ctl, atl, (ctl - atl) AS tsb FROM pmc  -- TSB = form
```

CTL = chronic training load (fitness), ATL = acute training load (fatigue), TSB = training stress balance (form). TSB < -20 = too fatigued; TSB > +10 = well-rested.

#### Strava Token Management (`etl/extract/strava_refresh.py`)

```python
# Smart refresh: only calls Strava if token expires in <5 min
expires_at = tokens["expires_at"]
if time.time() < expires_at - 300:
    return tokens["access_token"]   # still valid

# Refresh via POST /oauth/token
# Atomic write: write to .tmp, then os.replace() — prevents partial reads
```

**Why atomic write:** The poller runs every 5 min. A crash mid-write could produce corrupt JSON, locking the system out of Strava. `os.replace()` is atomic on all platforms.

#### MyFitnessPal Auth Strategy (`integrations/mfp/mfp_auth.py`)

MFP has no official API. Two-tier approach:
1. **Production:** Cookie file `mfp_cookies.txt` — exported once, reused. Warns if >30 days old.
2. **Development (Windows):** `browser_cookie3` reads cookies live from Chrome/Firefox. Requires running browser session.

**Known limitation:** MFP cookies expire; manual re-export is a maintenance task.

---

### Data Model & Flow

**Entity Relationships:**
- `workout_summary` → `workouts_raw` (1:1, workout_id FK)
- `workout_samples` → `workouts_raw` (N:1, workout_id FK)
- `oura_hr_samples` → `oura_sleep_raw` (N:1, sleep_id FK)
- `workout_summary` → `ftp_history` (logical lookup, no FK constraint — by date)
- `daily_physical_state` ← Notion Daily Physical State DB (synced via API)
- `workouts_raw` → Notion Workout DB (synced via `notion_workouts_view`)

**Data flow for a typical day:**
```
06:00 — Oura poller runs: fetches last 3 nights sleep + readiness + HR + 1 day activity → upserts 4 tables
07:00 — Notion reporter daily: queries PostgreSQL → calls Claude → posts morning briefing Notion page
08:00 — Notion state poller: reads athlete's journal entries → upserts daily_physical_state
09:30 — Athlete completes workout (Strava auto-sync)
09:35 — Strava poller (5-min interval): detects new activity → inserts raw + streams → computes NP/IF/TSS → syncs to Notion workout page
23:00 — MFP poller: fetches today's nutrition log → upserts nutrition_daily
```

**Storage strategy:** Flat normalized tables + JSONB `raw_json` columns. The JSONB enables future extraction of new fields without re-fetching APIs. 1.79M sample rows in `workout_samples` (~2 years of second-by-second cycling data).

**Analytics pattern:** `export_daily_json()` is the single aggregation entrypoint. It runs one large LEFT JOIN query rather than multiple roundtrips, producing a self-contained JSON for AI context.

---

### API Documentation

No HTTP API exposed. This is a local data pipeline. External APIs consumed:

| API | Auth | Key Endpoints Used |
|---|---|---|
| Strava v3 | OAuth 2.0 (code flow, automatic refresh) | `GET /athlete/activities`, `GET /activities/{id}/streams` |
| Oura v2 | Personal Access Token (Bearer) | `GET /usercollection/sleep`, `GET /usercollection/daily_activity` |
| Notion | Internal Integration Token | `POST /databases/{id}/query`, `POST /pages`, `PATCH /pages/{id}`, `PATCH /blocks/{id}/children` |
| MyFitnessPal | Cookie-based (unofficial) | Day-level nutrition data via `myfitnesspal` Python library |
| Anthropic | API Key (Bearer) | `POST /v1/messages` (claude-opus-4-5, claude-opus-4-6) |

---

### Deployment & DevOps

**Current infrastructure:** Local Windows machine, no containerization, no cloud deployment.

**Python runtime:** `venv/Scripts/python` (Windows venv). Packages in `requirements.txt`.

**Node.js runtime:** `notion-reporter/` subproject with own `node_modules/`. Uses ES modules (`"type": "module"`).

**Process management:**
- Python: `python scheduler_all.py` runs in foreground (or Windows Task Scheduler)
- Node.js: `npm run daily` / `npm run weekly` triggered by cron or Task Scheduler

**Scheduling options documented in `notion-reporter/index.mjs`:**
- Unix: crontab entries at 7am (daily) and 8pm Sunday (weekly)
- Windows: Task Scheduler with `REPORT_MODE` env var

**Secrets management:** `.env` files in `health_data_hub/config/` (gitignored). `strava_tokens.json` and `mfp_cookies.txt` also gitignored.

**No CI/CD pipeline** — solo personal project, changes pushed manually.

---

### Performance & Optimization

**Current scale:** 806 workouts, 1.79M sample rows, 14,912 HR samples, ~200 sleep records. All queries complete in <100ms on local hardware.

**Bottlenecks:**
1. `export_daily_json()` runs a 20-table LEFT JOIN — scales linearly with workout count. No materialized views; currently re-computed on every AI invocation.
2. `workout_samples` table will grow indefinitely. No partitioning. At 1.79M rows for 2 years, expect ~900K rows/year. Index on `workout_id` handles current join patterns.
3. MFP poller has 1-second rate limiting in backfill (`run_mfp_backfill.py`) — necessary but slow for full re-sync.

**Optimization opportunities:**
- Materialize `analysis_daily_rollup_10d` as a refreshable materialized view
- Partition `workout_samples` by year
- Cache `export_daily_json()` output for 15 min (current AI calls re-query for every invocation)

---

### Security & Compliance

**Authentication:**
- Strava: OAuth 2.0 with automatic token refresh (no long-lived secrets in code)
- All other services: API keys/tokens in `.env` files (not hardcoded)

**Known security issue (pre-fix):** `poll_strava.py` on `main` branch prints `access_token` and `refresh_token` to stdout. Fixed in `fix/p2-strava-token-expiry` branch (pending merge).

**Secret storage:** `.env` files gitignored. `strava_tokens.json` gitignored. No secrets in committed code.

**Authorization:** Local machine only. No multi-user access, no HTTP server, no public endpoints.

**Data sensitivity:** Contains personal health biometrics, GPS tracks, nutrition logs. Stored only in local PostgreSQL instance.

**Compliance:** Personal-use only. Not HIPAA-regulated (personal, not commercial healthcare).

---

### Future Roadmap & Technical Debt

**Active technical debt (tracked in `main` branch known issues):**
1. **Token leak** — `poll_strava.py` debug prints expose OAuth tokens to stdout
2. **MFP cookie maintenance** — manual re-export required every ~30 days
3. **No connection pooling** — `get_connection()` creates a new psycopg2 connection per call; should use a pool for the polling daemon
4. **Legacy scheduler** — `scheduler.py` (Strava-only) superseded by `scheduler_all.py` but not removed
5. **10+ unmerged branches** — P0/P1/P2/P3 fix branches in flight but not yet merged to main

**Refactoring opportunities:**
- Merge all P0–P3 fix branches into main
- Extract Anthropic prompt strings into a `prompts/` module for easier tuning
- Add `mypy` type annotations to extract/transform/load modules
- Add integration tests that hit a test PostgreSQL instance (currently only pure-logic unit tests)

**Feature enhancement possibilities:**
- Heart Rate Variability trend analysis (HRV data exists, not yet used in AI prompts)
- Body weight tracking (MFP exports weight; not yet surfaced in PMC analysis)
- Automated FTP test detection and `ftp_history` update
- Garmin Connect integration (complement or replace Strava for non-cycling activities)
- Web dashboard (Grafana or custom) over PostgreSQL views

---

### Interview / Presentation Talking Points

**1. The NP/IF/TSS algorithm choice**
Rather than using a third-party library, the core sports-science metrics are implemented from scratch using NumPy. This keeps the dependency surface small and makes the math auditable. The algorithm is validated by 11 unit tests including the definitional invariant: "1 hour at FTP must produce exactly 100 TSS."

**2. Idempotent-first ETL design**
Every insert function uses `ON CONFLICT DO UPDATE`. The system can be rerun at any frequency without data duplication. This meant every poller could be scheduled aggressively without risk, and backfills could be interrupted and resumed safely.

**3. Bidirectional Notion sync**
Most Notion integrations write data in. This system also reads back out — the athlete's manually entered physical state (energy level, body signals, notes) flows from Notion into PostgreSQL, making it available for AI context. This gives the athlete a low-friction input interface (Notion mobile app) while keeping the data in the analytical system.

**4. Multi-runtime architecture (Python + Node.js)**
The ETL and polling layer uses Python (mature ecosystem for data: psycopg2, APScheduler, numpy). The Notion intelligence reporter was implemented as Node.js because the Anthropic and Notion official SDKs are both first-class in JavaScript, and the structured block-building API for rich Notion pages was easier to express in JavaScript. The shared state (PostgreSQL) bridges the two runtimes.

**5. What I'd do differently on v2**
- Add a proper connection pool from day one (psycopg2 pool or asyncpg)
- Use a secrets manager (1Password CLI or AWS Secrets Manager) instead of `.env` files, even for a local project
- Set up a materialized view refresh cycle for `analysis_daily_rollup_10d` rather than recomputing on every query
- Write integration tests against a test Postgres instance in addition to pure-logic unit tests

---

## SECTION 4: Quick Reference

### One-Page Summary

**App:** Health Data Hub — Personal health analytics and AI coaching platform

**Stack:** Python 3.x + PostgreSQL 14 + Node.js (notion-reporter) + Anthropic Claude

**External APIs:** Strava (OAuth 2.0), Oura Ring v2 (PAT), Notion (integration token), MyFitnessPal (cookie)

**Data volume:** 806 workouts, 1.79M sample rows, ~200 sleep nights, ~14.9K HR samples

**Core output:** Daily morning briefing, weekly review, on-demand training analysis (all via Claude AI)

**Key files:**
- Entry point (setup): `run_all.py`
- Entry point (daemon): `scheduler_all.py`
- Entry point (AI daily): `morning_briefing.py`
- Entry point (AI weekly): `weekly_plan.py`
- Entry point (AI training): `analyze_training.py`
- Entry point (Notion report): `notion-reporter/index.mjs`
- Config: `health_data_hub/config/settings.py`
- Schema: `health_data_hub/db/schema.sql`
- Core algorithm: `health_data_hub/etl/transform/build_workout_summary.py`

**Run ETL from scratch:**
```bash
HEALTH_ENV=dev venv/Scripts/python run_all.py           # init DB + backfill + build summaries
HEALTH_ENV=dev venv/Scripts/python scheduler_all.py     # start polling daemon
```

**Run AI analysis:**
```bash
HEALTH_ENV=dev venv/Scripts/python morning_briefing.py
HEALTH_ENV=dev venv/Scripts/python analyze_training.py
cd notion-reporter && REPORT_MODE=daily node index.mjs
```

**Run tests:**
```bash
HEALTH_ENV=test venv/Scripts/python -m pytest tests/
```

---

*Generated 2026-03-18 via codebase analysis.*
