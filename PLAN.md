# Plan: Code cleanup: remove dead code and stale docs, add ruff and an unused-export check, one config source per constant
Branch: orch/code-cleanup
## Context
- Stack: Python ETL + `scheduler_all.py` (`health_data_hub/`, tests in `tests/`), Node 22 ESM services `dashboard/`, `health-mcp/`, `notion-reporter/`, `cloudflare-worker/`, Postgres schema in `health_data_hub/db/`.
- Tests: `venv/Scripts/python -m pytest -q`; per service `cd <service> && npm test`; integration `cd <service> && TEST_DATABASE_URL=postgres://postgres@localhost:5433/hdh_test npm run test:integration` (test cluster only, never the Pi).
- Baseline 2026-11-07: pytest 78 pass, dashboard 205, health-mcp 64, notion-reporter 30, cloudflare-worker 9, all green. No lint configured (`.claude/kit.json` `commands.lint` is empty).
- Base: main after `orch/goal-1900-maintenance` is merged (D1).
- Headless runs use `--permission-mode dontAsk`: run checks via `npm test`, `npm run <script>`, `node --test`, `node <script>`, `venv/Scripts/python -m <tool>`.
- No-touch: `health_data_hub/db/**` (schema, migrations, baseline), `nutrition_daily_legacy` and all data, `health-mcp/oauth.mjs`, `health_data_hub/config/*.env*`, `dashboard/Dockerfile`, `dashboard/docker-compose.yml`, deployed env files on the Pi.
## Decisions
- D1: Base branch -> merge `orch/goal-1900-maintenance` into main first; this plan branches from that main.
- D2: Dead code and stale docs -> delete outright (git history keeps them), including `archive/`. CLI tools that are still useful stay: `run_all.py`, `backfill_body_measurements.py`, `etl/extract/strava_reauth_headless.py`, `etl/extract/strava_webhook_setup.py`, `integrations/oura/run_oura_backfill.py`, `integrations/sync_weekly_powerzone_summary.py`, `etl/import_planned_workouts.py` (notion-reporter reads `planned_workouts`), `quality/`.
- D3: Lint -> ruff for Python (rules F and I) in requirements and CI; Node gets no new dependencies, and a repo script `scripts/check-unused-exports.mjs` fails on exports that nothing references.
- D4: Constants -> one config source per service: maintenance 2620 and plan pace 0.6545 are read once from that service's config/env reader; 7700 kcal/kg is one named constant per service; prompt text interpolates the configured value. No DB change.
- D5: Node test runner form (Q8) -> `node --test scripts/test/*.test.mjs` (a glob, not a directory) in T11 and T16 Done-when and in the CI step; Node 22.14 loads a directory argument as a module.
## Assumptions
- A1: `health_data_hub/integrations/apple_health/nutrition_reader.py` is dead, not merely unreferenced: it reads `nutrition_daily` as a table, which migration 2026-11_02 renamed to `nutrition_daily_legacy` and replaced with a view of a different shape.
- A2: The 5-file cap counts hand edits. Deletions, `ruff --fix` output and removing only an `export` keyword or an unused import are mechanical and don't count toward it.
- A3: The count-3 lesson (spec-integrity per-task re-spec) is a change to `.claude/hooks/spec-integrity.sh` in the agent-kit plugin repo, not this repo. It is out of scope here and its LESSONS.md line stays until that kit change lands.
- A4: `power_zone_graph.py:478` grouping rides by UTC day is a known bug (LESSONS, 2026-10-26), so fixing it belongs in this cleanup even though it changes the weekly zone summary for rides that start after 17:00 PT.
- A5: Logging conversion applies only to modules the scheduler imports (directly or transitively). CLI entry points keep `print` for operator output.
- A6: Ruff runs on the Python version CI already uses; ruff's `target-version` is left at its default unless a finding depends on it.
## Default policy
- If ambiguous, follow the existing pattern in the file being edited and log the choice in the task's Notes.
- Behavior stays the same except where a task's Outcome says it changes (only T10 and the prompt text in T13). A cleanup edit that would change output, a query result or a schedule is a needs-decision.
- Before deleting a file or an export, `git grep -w <name>` across the repo. If anything outside the files being deleted still uses it, keep it and log that in Notes.
- New Python tests go in `tests/` as `test_<topic>.py` and mock the DB like `tests/test_scheduler_wrappers.py`. New Node tests go in the service's `test/unit/`. Once T5 is done, every Python file a spec writer or worker adds must pass `venv/Scripts/python -m ruff check <file>`.
- Logging: `logger = logging.getLogger(__name__)` at module top, like `health_data_hub/integrations/apple_health/body_poller.py`; never log tokens or full API responses.
- No new dependencies except `ruff` (D3). No new env vars. If a task rewires a config key, the README env table for that service is updated in the same task.
- Report needs-decision only for: user-visible behavior not covered above, data loss, security, cost, or a spec test that looks wrong.
## Tasks
### T1: Delete dead Python modules, root scripts and archive/ [model: haiku] [risk: normal] [status: done] [deps: none]
**Outcome**: `analyze_training.py`, `print_recent.py`, `health_data_hub/integrations/apple_health/nutrition_reader.py`, `health_data_hub/utils/units.py` and the whole `archive/` directory are gone and every test suite still passes.
**Files**: `analyze_training.py` (delete), `print_recent.py` (delete), `health_data_hub/integrations/apple_health/nutrition_reader.py` (delete), `health_data_hub/utils/units.py` (delete), `archive/` (delete all 7 files)
**Non-goals**: no edits to the files that stay; docs that mention these files are T3/T4's job; the `nutrition_daily_legacy` table is not touched.
**Acceptance tests**: none: deletion only; Done-when proves the files are gone, nothing in code still imports them, and the suites pass.
**Done-when**: `test ! -e analyze_training.py && test ! -e print_recent.py && test ! -e archive && test ! -e health_data_hub/integrations/apple_health/nutrition_reader.py && test ! -e health_data_hub/utils/units.py && ! git grep -nE "nutrition_reader|utils\.units|convert_kj_to_kcal|analyze_training|print_recent|archive/" -- '*.py' '*.mjs' '*.js' '*.sh' '*.service' '*.yml' '*.json' ':!**/package-lock.json' && venv/Scripts/python -m pytest -q`
**Decision rule**: If a code file outside this list imports one of them, keep that file, log it in Notes, and finish the rest.
**Notes**: Nothing outside the deleted files referenced them; nothing kept.
Metrics: attempts=1 fix=0 review=none blocked=none


### T2: Delete stale planning docs [model: haiku] [risk: normal] [status: done] [deps: none]
**Outcome**: `PI_MIGRATION_PLAN.md`, `TECHNICAL_ANALYSIS.md`, `n8n-health-coach-discovery.md`, `docs/nutrition-build-plan.md` and `prompts/` are gone, and no tracked file links to them.
**Files**: `PI_MIGRATION_PLAN.md` (delete), `TECHNICAL_ANALYSIS.md` (delete), `n8n-health-coach-discovery.md` (delete), `docs/nutrition-build-plan.md` (delete), `prompts/future/more automations` (delete)
**Non-goals**: no edits to runbooks (`docs/*runbook*.md`, `docs/nutrition_logging.md`, `docs/health_auto_export_setup.md`) except removing a link to a deleted file.
**Acceptance tests**: none: deletion only; Done-when proves the files are gone and nothing references them.
**Done-when**: `test ! -e PI_MIGRATION_PLAN.md && test ! -e TECHNICAL_ANALYSIS.md && test ! -e n8n-health-coach-discovery.md && test ! -e docs/nutrition-build-plan.md && test ! -e prompts && ! git grep -nE "PI_MIGRATION_PLAN|TECHNICAL_ANALYSIS|n8n-health-coach|nutrition-build-plan|prompts/future" -- ':!PLAN.md' ':!LESSONS.md' ':!RUNLOG.md'`
**Decision rule**: If another doc links to a deleted file, remove the link sentence; if the link carries information that exists nowhere else, keep a one-line summary in its place and log it in Notes.
**Notes**: Only reference was inside a deleted doc; no links edited.
Metrics: attempts=1 fix=0 review=none blocked=none


### T3: Docs check: relative links resolve and runbook check steps are read-only [model: sonnet] [risk: normal] [status: done] [deps: T2]
**Outcome**: `venv/Scripts/python -m pytest -q tests/test_docs.py` fails when a tracked markdown file has a relative link to a missing path, or when a runbook check step contains a write command. This promotes the count-2 lesson "A runbook check step must not have side effects in production".
**Files**: `tests/test_docs.py` (new; list files with `git ls-files` via `subprocess` like `tests/test_scheduler_wrappers.py` uses stdlib only), `LESSONS.md` (delete the "runbook check step must not have side effects" line as the last step), up to 3 runbook files only if the current tree fails the check
**Non-goals**: no external URL checks; no change to runbook meaning beyond making a check step read-only.
**Acceptance tests**: `tests/test_docs.py`: (a) scans every tracked `*.md` except `PLAN.md`, `LESSONS.md`, `RUNLOG.md`, `.claude/**`, `.github/**`; (b) every relative markdown link target (strip `#anchor`) exists relative to the linking file; (c) a "check step" is a line matching `(?i)\b(check|verify|smoke[- ]test)\b[^:\n]*:` plus the fenced code block that directly follows it; (d) a check step fails if its inline or fenced code matches any of: SQL `\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b`, `curl` with `-X (POST|PUT|PATCH|DELETE)` or `-d`/`--data`, `systemctl (start|stop|restart)`, `docker compose (up|down|restart)`, `psql .* -f `; (e) self-tests of the detector on inline sample strings: one passing read-only sample and one failing sample per pattern in (d); (f) the current tree passes.
**Done-when**: `venv/Scripts/python -m pytest -q tests/test_docs.py && ! grep -q "runbook \"check\" step must not have side effects" LESSONS.md`
**Decision rule**: If the current tree fails (b) or (d) in more than 3 files, report needs-decision with the list rather than editing them.
**Notes**: Current tree passed the check; no runbooks edited. LESSONS line deleted.
Metrics: attempts=1 fix=0 review=none blocked=none


### T4: README describes the current system; drop finished Datawrapper and nutrition-poller instructions [model: sonnet] [risk: normal] [status: done] [deps: T1, T2, T3]
**Outcome**: `README.md` lists each component with its purpose, test command and docs link; `dashboard/README.md` and `docs/health_auto_export_setup.md` no longer give Datawrapper or `nutrition_poller` instructions.
**Files**: `README.md` (rewrite), `dashboard/README.md` (remove the Datawrapper mention at :7 and the finished live steps at :147-155 and :237-238), `docs/health_auto_export_setup.md` (remove the `nutrition_poller` setup at :14, :76, :185; nutrition is logged through health-mcp, see `docs/nutrition_logging.md`), `tests/test_readme.py` (new)
**Non-goals**: no edits to `docs/nutrition_deploy_runbook.md` (its `nutrition_poller` lines describe a past deploy and rollback); no new docs files.
**Acceptance tests**: `tests/test_readme.py`: (a) `README.md` has a `## Components` section naming `health_data_hub/`, `scheduler_all.py`, `health-mcp/`, `notion-reporter/`, `dashboard/`, `cloudflare-worker/`; (b) a `## Tests` section contains `venv/Scripts/python -m pytest -q` and `npm test` and names every directory that `.github/workflows/kit-ci.yml` runs `npm test` in; (c) no tracked file outside `PLAN.md`, `LESSONS.md`, `RUNLOG.md` contains `datawrapper` (case-insensitive); (d) `docs/health_auto_export_setup.md` does not contain `nutrition_poller`.
**Done-when**: `venv/Scripts/python -m pytest -q tests/test_readme.py tests/test_docs.py`
**Decision rule**: If a Datawrapper or nutrition_poller paragraph also holds instructions that still apply (body measurements, Health Auto Export setup), keep those sentences and remove only the stale ones.
**Notes**: Scheduler row links health-data-hub.service (no pi/README.md). Also removed stale Datawrapper rollback and nutrition_poller manual-poll step.
Metrics: attempts=1 fix=0 review=none blocked=none


### T5: Add ruff (F, I) config and dependency [model: haiku] [risk: normal] [status: done] [deps: T1]
**Outcome**: `venv/Scripts/python -m ruff check .` runs with rules F and I, `health_data_hub` as first-party, and `venv`, `.venv` and `node_modules` excluded; ruff is installed from `requirements.txt`, so CI gets it from the same `pip install -r requirements.txt` step.
**Files**: `ruff.toml` (new), `requirements.txt` (add `ruff`), `requirements.pinned.txt` (add `ruff==<version>`)
**Non-goals**: no fixes to findings (T6-T8); no CI edits (T16); no rules beyond F and I.
**Acceptance tests**: none: config only; Done-when proves ruff is installed and the config parses with the expected rules.
**Done-when**: `venv/Scripts/python -m pip install -q -r requirements.txt && venv/Scripts/python -m ruff --version && venv/Scripts/python -m ruff check --exit-zero . >/dev/null && grep -qE 'select *= *\[ *"F" *, *"I" *\]' ruff.toml && grep -qi "^ruff" requirements.txt && grep -qi "^ruff==" requirements.pinned.txt`
**Decision rule**: Pin the newest ruff release on PyPI that is at least 14 days old and record it in Notes.
**Notes**: Pinned ruff==0.17.2 (0.17.3 dated 2026-10-27, under 14 days). venv resolves 0.17.4 from unpinned requirements.txt.
Metrics: attempts=1 fix=0 review=none blocked=none


### T6: Zero ruff findings in health_data_hub/etl [model: haiku] [risk: normal] [status: done] [deps: T5]
**Outcome**: `ruff check health_data_hub/etl` exits 0 and the Python suite passes.
**Files**: files under `health_data_hub/etl/` that ruff reports (mechanical per A2); `health_data_hub/etl/export_daily_json.py` drops its unused `DB_*` imports
**Non-goals**: no logic changes; no `# noqa` except for an import kept for its side effect, with a reason comment.
**Acceptance tests**: none: lint-only; Done-when runs ruff and the suite.
**Done-when**: `venv/Scripts/python -m ruff check health_data_hub/etl && venv/Scripts/python -m pytest -q`
**Decision rule**: Run `ruff check --fix` first. For any finding left (F841, F811 and similar), make the smallest edit that keeps behavior; if the only fix changes behavior, report needs-decision.
**Notes**: 28 findings, all mechanical (imports, unused psycopg2, one placeholder-less f-string).
Metrics: attempts=2 fix=0 review=none blocked=none


### T7: Zero ruff findings in health_data_hub/integrations, quality, utils, config [model: haiku] [risk: normal] [status: done] [deps: T5]
**Outcome**: `ruff check health_data_hub/integrations health_data_hub/quality health_data_hub/utils health_data_hub/config health_data_hub/__init__.py` exits 0 and the Python suite passes.
**Files**: files under those paths that ruff reports (mechanical per A2); known: `health_data_hub/integrations/oura/poll_oura.py` (unused `traceback`)
**Non-goals**: no logic changes; no edits under `health_data_hub/db/`.
**Acceptance tests**: none: lint-only; Done-when runs ruff and the suite.
**Done-when**: `venv/Scripts/python -m ruff check health_data_hub/integrations health_data_hub/quality health_data_hub/utils health_data_hub/config health_data_hub/__init__.py && venv/Scripts/python -m pytest -q`
**Decision rule**: Same as T6.
**Notes**: 12 findings, mechanical; poll_oura unused traceback removed.
Metrics: attempts=1 fix=0 review=none blocked=none


### T8: Zero ruff findings in root scripts and tests [model: haiku] [risk: normal] [status: done] [deps: T5]
**Outcome**: `ruff check run_all.py scheduler_all.py backfill_body_measurements.py tests` exits 0 and the Python suite passes.
**Files**: those root scripts and files under `tests/` that ruff reports (mechanical per A2); known: `tests/test_body_parser.py`, `tests/test_quality.py` (unused imports)
**Non-goals**: no change to what a test asserts; no edits to files committed as `T<n>-spec:` on this branch.
**Acceptance tests**: none: lint-only; Done-when runs ruff and the suite.
**Done-when**: `venv/Scripts/python -m ruff check run_all.py scheduler_all.py backfill_body_measurements.py tests && venv/Scripts/python -m pytest -q`
**Decision rule**: If a finding is in a `T<n>-spec:` file from this branch, report needs-decision (spec files are read-only).
**Notes**: Removed unused FakeConn local in test_quality.py. First worker run blocked only on parallel T4 spec test; re-run committed.
Metrics: attempts=2 fix=0 review=none blocked=none


### T9: Scheduler-reachable modules log instead of print [model: sonnet] [risk: normal] [status: done] [deps: T6, T7]
**Outcome**: No module that `scheduler_all.py` imports, directly or transitively within `health_data_hub`, calls `print()` outside an `if __name__ == "__main__":` block; those messages go through `logging` at the same point in the code.
**Files**: `tests/test_no_print_in_scheduler.py` (new), `health_data_hub/integrations/notion/notion_strava_sync.py`, `health_data_hub/etl/extract/strava_refresh.py`, `health_data_hub/etl/extract/strava_oauth.py`, plus any other module the test finds (copy the logger pattern in `health_data_hub/integrations/apple_health/body_poller.py`)
**Non-goals**: CLI-only modules keep `print` (A5); no change to log setup in `health_data_hub/utils/logging_config.py`; no message text changes except dropping secrets.
**Acceptance tests**: `tests/test_no_print_in_scheduler.py`: (a) builds the import closure from `scheduler_all.py` by parsing `import`/`from` statements with `ast` and following `health_data_hub.*` modules; (b) asserts the closure includes `health_data_hub.integrations.poll_strava` and `health_data_hub.integrations.notion.notion_strava_sync` (guards against an empty closure); (c) no `print` call in any closure module outside an `if __name__ == "__main__":` block; (d) `strava_oauth.py`'s token-exchange failure path doesn't log the response body (assert with a mocked `requests.post` returning a body containing `access_token` and `caplog`).
**Done-when**: `venv/Scripts/python -m pytest -q && venv/Scripts/python -m ruff check health_data_hub tests`
**Decision rule**: print -> `logger.info`, a print in an error branch -> `logger.warning` or `logger.error` by existing wording. If the closure has more than 5 files with prints, convert them all (mechanical) and log the count in Notes.
**Notes**: Closure had 2 files with prints (21 calls). strava_oauth.py is CLI-only but its prints were converted too because spec (d) checks stdout; its operator messages now need logging configured.
Metrics: attempts=1 fix=0 review=none blocked=none


### T10: Weekly power-zone summary groups rides by Los Angeles day [model: sonnet] [risk: normal] [status: done] [deps: T6]
**Outcome**: The query at `health_data_hub/etl/transform/power_zone_graph.py:478` picks rides by their America/Los_Angeles start date, so a Sunday 18:00 PT ride counts in that week, not the next.
**Files**: `health_data_hub/etl/transform/power_zone_graph.py` (copy `(start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date` from `notion-reporter/src/utils/db.mjs:79`), `tests/test_power_zone_day.py` (new), `LESSONS.md` (delete the line beginning "notion-reporter/src/utils/db.mjs:79 and power_zone_graph.py:478" as the last step)
**Non-goals**: no other query or chart changes; no backfill of past Notion summaries.
**Acceptance tests**: `tests/test_power_zone_day.py`: (a) with a mocked cursor, the SQL the weekly query executes converts `start_time` from UTC to `America/Los_Angeles` before `::date`; (b) no remaining `start_time::date` in `power_zone_graph.py`; (c) the date parameters passed are the week's Monday and Sunday unchanged.
**Done-when**: `venv/Scripts/python -m pytest -q && ! grep -q "power_zone_graph.py:478 still group" LESSONS.md`
**Decision rule**: If `workouts_raw.start_time` turns out to be `timestamptz`, use `(start_time AT TIME ZONE 'America/Los_Angeles')::date` instead and log it in Notes.
**Notes**: workouts_raw.start_time is naive TIMESTAMP (schema.sql:16), so used the double AT TIME ZONE form.
Metrics: attempts=1 fix=0 review=none blocked=none


### T11: Unused-export checker for the Node services [model: sonnet] [risk: normal] [status: done] [deps: none]
**Outcome**: `node scripts/check-unused-exports.mjs` prints each `path name` that is exported but referenced by no other tracked `.mjs`/`.js` file, and exits 1 if any exist; it uses only Node built-ins.
**Files**: `scripts/check-unused-exports.mjs` (new), `scripts/unused-exports.allow` (new; `path name  # reason` per line, starts empty), `scripts/test/check-unused-exports.test.mjs` (new)
**Non-goals**: no fixes to findings (T14, T15); no root `package.json`; no new dependencies.
**Acceptance tests**: `scripts/test/check-unused-exports.test.mjs` on temp-dir fixtures: (a) `export function|const|let|class|async function NAME` and `export { a, b as c }` are collected; (b) a name counts as used when another file contains it as a whole word (tests included); (c) `import * as ns from './x.mjs'` marks every export of `x.mjs` used; (d) allowlisted `path name` pairs are skipped; (e) exit 0 with no findings, exit 1 and one `path name` line per finding otherwise; (f) scans `git ls-files` output, skipping `node_modules/` and `package-lock.json`.
**Done-when**: `node --test scripts/test/*.test.mjs`
**Decision rule**: Prefer false negatives over false positives: if a pattern is ambiguous (string-built names, re-exports), treat the export as used and log the case in Notes.
**Notes**: Spec 550943c written. Done-when changed from the directory form to the glob form by D5 (Q8, 2026-11-16).
Worker: 12/12 spec tests pass; real repo yields 26 findings for T14/T15. Ambiguous cases (`export {..} from` re-exports, `import * as`, dynamic import) count as used.
Metrics: attempts=1 fix=0 review=none blocked=none


### T12: Dashboard reads maintenance, plan pace and kcal/kg from one place [model: sonnet] [risk: normal] [status: done] [deps: none]
**Outcome**: In `dashboard/src` and `dashboard/public/js`, the literals `2620` and `0.6545` appear only in `dashboard/src/config.mjs`, and `7700` appears only once as a named constant; the aggregate's `?? 2620` fallback and `demo.mjs`'s `0.6545` read the config value instead.
**Files**: `dashboard/src/aggregate.mjs` (:10, :43), `dashboard/src/demo.mjs` (:80), `dashboard/src/config.mjs` (:16-17, export the parsed defaults), `dashboard/test/unit/constants.test.mjs` (new), `dashboard/README.md` (env table, only if a key or default changes)
**Non-goals**: no change to any number the dashboard shows with the default env; no new env vars.
**Acceptance tests**: `dashboard/test/unit/constants.test.mjs`: (a) scanning `dashboard/src/**` and `dashboard/public/js/**`, `2620` and `0.6545` appear only in `src/config.mjs` and `7700` appears exactly once; (b) aggregate with no `maintenanceKcal` input uses the config default 2620; (c) with `MAINTENANCE_KCAL=2500` the aggregate's maintenance is 2500; (d) demo data's `planKgPerWeek` equals the config `PLAN_KG_PER_WEEK`.
**Done-when**: `cd dashboard && npm test`
**Decision rule**: If a literal is needed in browser code (`public/js`), have the server pass it in the API payload rather than duplicating it; if that changes the payload shape, add the field without removing any.
**Notes**: Added DEFAULT_* constants and energyDefaults() to config.mjs (no token/DB validation, so aggregate/demo can import at load). KCAL_PER_KG 7700 already single; README untouched.
Metrics: attempts=1 fix=0 review=none blocked=none


### T13: notion-reporter reads maintenance and plan pace from one place; prompts use the configured numbers [model: sonnet] [risk: normal] [status: done] [deps: none]
**Outcome**: In `notion-reporter/src` and `notion-reporter/index.mjs`, `2620` and `0.6545` appear only as the defaults in `nutritionWeek.mjs`, `7700` appears once, and the prompt text in `analyzeHealth.mjs:85` and `:185` uses the configured maintenance value instead of a literal.
**Files**: `notion-reporter/src/anthropic/analyzeHealth.mjs` (:85, :185), `notion-reporter/src/utils/nutritionWeek.mjs` (:5-18), `notion-reporter/test/unit/constants.test.mjs` (new; copy prompt-building setup from `notion-reporter/test/unit/weekly_prompt.test.mjs`)
**Non-goals**: no other prompt wording changes; no new env vars; no change to the weekly or daily math.
**Acceptance tests**: `notion-reporter/test/unit/constants.test.mjs`: (a) scanning `notion-reporter/src/**` and `index.mjs`, `2620` and `0.6545` appear only in `src/utils/nutritionWeek.mjs` and `7700` exactly once; (b) with the maintenance env var unset, the daily and weekly prompts contain `2620`; (c) with it set to `2500`, both prompts contain `2500` and not `2620`.
**Done-when**: `cd notion-reporter && npm test`
**Decision rule**: Use whatever env var name `nutritionWeek.mjs:18` already reads; if the daily and weekly prompts are built in different files, both read the same exported getter.
**Notes**: Both prompts interpolate maintenanceKcal() from nutritionWeek.mjs; the daily prompt is in a commented-out block.
Metrics: attempts=1 fix=0 review=none blocked=none


### T14: Remove unused exports in dashboard [model: haiku] [risk: normal] [status: todo] [deps: T11, T12]
**Outcome**: `node scripts/check-unused-exports.mjs` reports nothing under `dashboard/`, and dashboard unit tests pass.
**Files**: `dashboard/public/js/core.mjs`, `dashboard/public/js/charts/common.mjs`, `dashboard/public/js/charts/balance.mjs`, `dashboard/public/js/charts/ftp.mjs`, `dashboard/public/js/charts/nutrition.mjs`, `dashboard/public/js/charts/weight.mjs` (removing an `export` keyword is mechanical per A2)
**Non-goals**: no rendering changes; no edits to `dashboard/src` beyond what the checker reports.
**Acceptance tests**: none: the T11 checker and the existing dashboard suite are the check.
**Done-when**: `node scripts/check-unused-exports.mjs | (! grep -q "^dashboard/") && cd dashboard && npm test`
**Decision rule**: If a name is used inside its own file, drop only `export`; if it's used nowhere, delete it. Never add a name to the allowlist without a reason comment.
**Notes**: Dropped `export` from names used in their own file; deleted unreferenced `fmtDeficit` (balance.mjs). Checker clean for dashboard/, npm test 210 pass.
Metrics: attempts=1 fix=0 review=PASS blocked=none

### T15: Remove unused exports in health-mcp and notion-reporter [model: haiku] [risk: normal] [status: done] [deps: T11, T13]
**Outcome**: `node scripts/check-unused-exports.mjs` exits 0 (nothing left anywhere), and the health-mcp, notion-reporter and cloudflare-worker unit tests pass.
**Files**: `health-mcp/app.mjs`, `health-mcp/tools/nutrition/{common,edit,favorites,log-food,search,summary}.mjs`, `notion-reporter/src/utils/nutritionWeek.mjs`, `scripts/unused-exports.allow` (mechanical per A2)
**Non-goals**: no change to MCP tool names, descriptions or schemas; `health-mcp/oauth.mjs` is not touched.
**Acceptance tests**: none: the T11 checker and the existing suites are the check.
**Done-when**: `node scripts/check-unused-exports.mjs && cd health-mcp && npm test && cd ../notion-reporter && npm test && cd ../cloudflare-worker && npm test`
**Decision rule**: Same as T14. Tool `*_DESCRIPTION` constants used in their own file lose only `export`.
**Notes**: Dropped `export` from 14 health-mcp names used in their own file; nutritionWeek.mjs needed nothing; no allowlist entries. Checker exits 0.
Metrics: attempts=1 fix=0 review=PASS blocked=none

### T16: CI and kit run ruff, the unused-export check and cloudflare-worker tests [model: sonnet] [risk: high] [status: done] [deps: T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15]
**Outcome**: The CI workflow runs `python -m ruff check .`, `node scripts/check-unused-exports.mjs`, `node --test scripts/test/*.test.mjs` and `cloudflare-worker` `npm ci && npm test`; `.claude/kit.json` `commands.lint` runs ruff and the export check; every check passes on the branch.
**Files**: `.github/workflows/kit-ci.yml` (add steps beside the existing pytest step at :14-15 and the npm steps at :46-66), `.claude/kit.json` (`commands.lint`)
**Non-goals**: no change to existing CI steps, triggers or the Postgres service; no other kit.json keys.
**Acceptance tests**: none: CI config; Done-when runs every new check locally and greps the workflow for each step.
**Done-when**: `venv/Scripts/python -m ruff check . && node scripts/check-unused-exports.mjs && node --test scripts/test/*.test.mjs && venv/Scripts/python -m pytest -q && (cd dashboard && npm test) && (cd health-mcp && npm test) && (cd notion-reporter && npm test) && (cd cloudflare-worker && npm test) && grep -q "ruff check" .github/workflows/kit-ci.yml && grep -q "check-unused-exports" .github/workflows/kit-ci.yml && grep -q "cloudflare-worker" .github/workflows/kit-ci.yml && grep -q "ruff" .claude/kit.json`
**Decision rule**: Every tool a new CI step runs must be installed by the files that workflow installs from (ruff from `requirements.txt`; Node built-ins only). If ruff fails on a `T<n>-spec:` file, report needs-decision.
**Notes**: Deviation: cloudflare-worker step runs `npm test` without `npm ci` (no package-lock.json; tests use only node: built-ins). Ruff step follows pip install; script steps use working-directory overrides in the node job.
Lesson: Before writing `npm ci` into a CI step, check that the directory has a package-lock.json, or the step fails. | applies: CI workflow tasks that add Node steps
Metrics: attempts=1 fix=0 review=PASS blocked=none
