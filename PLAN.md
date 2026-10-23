# Plan: FTP and W/kg Datawrapper charts for Notion, refreshed from the hub
Branch: orch/ftp-wkg-charts
## Context
- Python 3 package `health_data_hub/`; Postgres `health` (prod runs on the Pi via `scheduler_all.py`, APScheduler, systemd `health-hub.service`).
- Test: `venv/Scripts/python -m pytest -q` (68 passing on main at 3fff400). No lint/typecheck configured.
- Inputs: `ftp_history(id, effective_from timestamptz, ftp_watts)` (5 rows, 2024-01-01 → 2026-04-30, stored as local midnight America/Los_Angeles); view `body_weight_daily(day date, weight_kg numeric, …)` (159 weigh-in days since 2020-10-30, sparse).
- Output: two Datawrapper line charts (FTP, W/kg) embedded in Notion, refreshed by a Pi job that pushes data over the Datawrapper API.
- Datawrapper facts (verified 2026-10-23): free plan allows publish + embed; API free tier per workspace per month = 500 create, 1,000 publish, 3,000 export ops (billing from 2026-10-01); dual-axis charts are paid-only; Notion embeds Datawrapper links (official Datawrapper guide). API: `POST /v3/charts`, `PUT /v3/charts/{id}/data` (text/csv), `PATCH /v3/charts/{id}` (metadata), `POST /v3/charts/{id}/publish`, base `https://api.datawrapper.de`, header `Authorization: Bearer <token>`.
- No-touch: `health_data_hub/db/`, `.claude/`, `.github/`, any `*.env*` file, `strava_tokens*.json`, all existing pollers.
- Live steps (Pi deploy, token, first publish, Notion check) happen after merge, outside this run.
## Decisions
- D1: Chart layout -> two separate line charts (FTP, W/kg). No dual-axis (paid-only, and the brief rejects it).
- D2: W/kg rows -> every `body_weight_daily` day with a weight on or after the first FTP date, plus each FTP effective date. `ftp_w` is the latest FTP effective on or before the row date (step, carried forward). `weight_kg` is the measured value; on an FTP date with no weigh-in it is linearly interpolated between the previous and next weigh-in (any distance; weights before the first FTP date are used for this), or the single available neighbour if only one side exists. `wkg = round(ftp_w / weight_kg, 2)`.
- D3: Data delivery -> the Pi job pushes CSV over the Datawrapper API (`PUT data` + `publish`). No public CSV URL, no Google Sheet, no n8n. Reason: Datawrapper's external-CSV mode needs a public HTTPS+CORS endpoint or stops refreshing 30 days after the last publish, and free-plan support for it is undocumented; API push has neither problem and stays within the free quota.
- D4: Repo -> local main was reset to origin/main (backup branch `main-local-pre-rewrite`) and the kit commit re-applied (3fff400). CLAUDE.md stays untracked, per origin's .gitignore.
- D5 (auto, T1): spec test_a passed only the D0 FTP row, so ftp_day is not an FTP date and D2 emits no row for it -> spec writer amends test_a to pass `[(D0, 200), (ftp_day, 200)]` [source: D2]
## Assumptions
- A1: FTP dates are local dates: convert with `(effective_from AT TIME ZONE 'America/Los_Angeles')::date`. Safe: all 5 rows are 07:00/08:00 UTC = PT midnight.
- A2: The CSV also carries a `weight_source` column (`measured` | `interpolated` | `nearest`) so interpolated points are auditable. The tidy columns requested (date, ftp_w, weight_kg, wkg) come first in that order.
- A3: The last row is the latest of (last weigh-in day, last FTP date); no synthetic "today" row, so data only changes when a weigh-in or FTP test lands. This keeps publish ops at ≤ 2 per new weigh-in.
- A4: Dark mode uses Datawrapper's `metadata.publish.autoDarkMode = true`, which follows the viewer's OS/browser setting, not Notion's in-app theme toggle.
- A5: Notion gets the unversioned embed URL `https://datawrapper.dwcdn.net/<chart_id>/`, which always serves the latest published version.
- A6: Job cadence: hourly at :40 from 06–23 (20 minutes after `body_poller`). Each run recomputes the CSV and makes zero API calls when its SHA-256 matches the stored one.
## Default policy
- If ambiguous, follow the existing pattern in `health_data_hub/integrations/apple_health/body_poller.py:278` (`poll_once` returns an int exit code, logs, never raises) and log the choice in the task's Notes.
- Config: read new env vars in `health_data_hub/config/settings.py` next to the `HEALTH_WORKER_URL` block (line ~92), with `os.getenv` and a default.
- HTTP: `requests` with `timeout=15`; on non-2xx log status and the first 300 chars of the body; never log the token or the Authorization header.
- Tests: pytest under `tests/`, patch `requests` and `get_connection` with `monkeypatch`/`MagicMock` as in `tests/test_body_poller.py:33`; no network, no DB.
- No new dependencies (requests, psycopg2 already pinned).
- Report needs-decision only for: user-visible behavior not covered above, data loss, security, cost, or a spec test that looks wrong.
## Tasks
### T1: Build the FTP/weight/W-kg dataset [model: sonnet] [risk: normal] [status: done] [deps: none]
**Outcome**: `build_rows(ftp_rows, weight_rows)` returns the D2 row set and `to_csv(rows)` returns a CSV string with header `date,ftp_w,weight_kg,wkg,weight_source`; `fetch_inputs(conn)` reads both tables per A1.
**Files**: `health_data_hub/etl/transform/build_ftp_wkg.py` (new), `tests/test_build_ftp_wkg.py` (new)
**Non-goals**: No API calls, no file writes outside `write_csv(rows, path)`, no scheduler changes, no DB writes.
**Acceptance tests**: `tests/test_build_ftp_wkg.py`: (a) FTP date with weigh-ins 10 days before (100.0 kg) and 10 days after (102.0 kg) yields weight_kg 101.0, source `interpolated`; (b) FTP date with only an earlier weigh-in uses it, source `nearest`; (c) weigh-in rows carry the latest FTP on or before their date, source `measured`; (d) weigh-ins before the first FTP date are excluded from output but used for interpolation; (e) a weigh-in on an FTP date yields one row, source `measured`; (f) wkg = round(ftp/weight, 2), e.g. 215 W / 116.0 kg -> 1.85; (g) rows sorted ascending by date with unique dates; (h) CSV header and ISO dates exactly as specified; (i) `fetch_inputs` SQL converts `effective_from` with `AT TIME ZONE 'America/Los_Angeles'` (assert on the executed SQL string via a mock cursor); (j) empty FTP input returns [].
**Done-when**: `venv/Scripts/python -m pytest -q tests/test_build_ftp_wkg.py && venv/Scripts/python -m pytest -q`
**Decision rule**: Ties or gaps not covered by D2 -> pick the rule that keeps every FTP date in the output and log it in Notes.
**Notes**: Spec test_a fixed per D5. Implementation follows D2; no gaps hit.
Metrics: attempts=2 fix=0 review=none blocked=spec
### T2: Datawrapper chart sync job [model: sonnet] [risk: high] [status: done] [deps: T1]
**Outcome**: `sync_once(dry_run=False) -> int` builds rows via T1, writes the CSV to `FTP_WKG_CSV_PATH`, and when the CSV SHA-256 differs from the stored one (or no chart IDs exist) creates missing charts, PATCHes styling, PUTs each chart's data, publishes both, then stores IDs + hash; returns 0 ok, 1 API/DB error, 2 token missing (no network calls).
**Files**: `health_data_hub/integrations/datawrapper/__init__.py` (new), `health_data_hub/integrations/datawrapper/ftp_wkg_charts.py` (new), `health_data_hub/config/settings.py` (add `DATAWRAPPER_API_TOKEN`, `DATAWRAPPER_STATE_FILE` default `~/.config/health-data-hub/datawrapper_charts.json`, `FTP_WKG_CSV_PATH` default `PROJECT_ROOT / "exports" / "ftp_wkg.csv"`), `tests/test_ftp_wkg_charts.py` (new)
**Non-goals**: No scheduler wiring, no Notion API calls, no export (PNG) calls, no external-CSV linking, no custom themes.
**Acceptance tests**: `tests/test_ftp_wkg_charts.py`: (a) token unset -> returns 2 and `requests` is never called; (b) first run with no state file -> exactly 2 `POST /v3/charts` with `type` `d3-lines`, then PATCH, PUT data, publish for each, state file written with both IDs and the hash; (c) second run with unchanged data -> zero HTTP calls, returns 0; (d) changed data with existing IDs -> no create calls, PUT + publish for both; (e) FTP chart CSV has columns `date,FTP (W)`, W/kg chart CSV has `date,W/kg`, both with identical date column; (f) PATCH metadata sets: title `FTP` / `Power-to-weight`, `visualize.custom-colors` FTP `#3B6EA8` and W/kg `#E08A3C`, `visualize.y-grid` `off`, `visualize.line-symbols` true with `line-symbols-on` `last`, FTP chart `visualize.interpolation` `step-after`, FTP chart `visualize.text-annotations` with one entry per FTP change labelled `<watts> W`, `publish.autoDarkMode` true; (g) a 500 on any call -> returns 1, state hash not updated, token string absent from captured logs; (h) state file written atomically (temp file + `os.replace`); (i) `--dry-run` CLI path writes the CSV and makes zero HTTP calls.
**Done-when**: `venv/Scripts/python -m pytest -q tests/test_ftp_wkg_charts.py && venv/Scripts/python -m pytest -q`
**Decision rule**: A Datawrapper metadata key not listed in (f) -> omit it rather than guess, and list it in Notes for the post-merge live check.
**Notes**: Live check post-merge: `custom-colors` keyed by column name, `text-annotations` entries `{x,y,text}`, `line-symbols-on: "last"`. Change detection hashes CSV only: docs should say delete the state file to force a re-PATCH.
Lesson: For jobs that must never raise, end with a catch-all `except Exception` that logs and returns 1; listing specific exception types misses TypeError and AttributeError | `sync_once` / `poll_once`-style jobs
Metrics: attempts=1 fix=0 review=PASS blocked=none
### T3: Schedule the job, CLI entry point, README [model: sonnet] [risk: normal] [status: done] [deps: T2]
**Outcome**: `scheduler_all.py` runs `sync_once` hourly at minute 40 from 06–23 (id `ftp_wkg_charts`, `max_instances=1`, wrapped like `run_body_poller`), the startup log line mentions it, `python -m health_data_hub.integrations.datawrapper.ftp_wkg_charts [--dry-run]` works, `exports/` is gitignored, and `docs/ftp_wkg_charts.md` documents data source, D2 rules, refresh schedule, env vars, Pi setup and rebuild steps.
**Files**: `scheduler_all.py` (copy `run_body_poller` at `scheduler_all.py:109` and its `add_job` block), `.gitignore`, `docs/ftp_wkg_charts.md` (new)
**Non-goals**: No change to other jobs' triggers; no deploy to the Pi.
**Acceptance tests**: none: wiring and docs; Done-when proves compile, job registration text and README sections.
**Done-when**: `venv/Scripts/python -m py_compile scheduler_all.py && grep -q 'id="ftp_wkg_charts"' scheduler_all.py && grep -q '^exports/' .gitignore && grep -qi 'rebuild' docs/ftp_wkg_charts.md && grep -q 'DATAWRAPPER_API_TOKEN' docs/ftp_wkg_charts.md && venv/Scripts/python -m pytest -q`
**Decision rule**: If the README needs a fact not in this plan, take it from D1–D4/A1–A6 and the code; do not invent setup steps.
**Notes**: `run_ftp_wkg_charts` has a catch-all except. README notes deleting the state file drops chart IDs, so Notion embeds then need updating.
Metrics: attempts=1 fix=0 review=none blocked=none
