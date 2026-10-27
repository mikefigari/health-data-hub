# Lessons

<!-- One line per lesson: `- <lesson> | count: N | last: YYYY-MM-DD | applies: <where>`.
Written by kit-run from reviewer findings. The planner reads it before planning and
folds matching lessons into task blocks. At count >= 2 the planner schedules a task that promotes
the lesson to a lint rule, hook or test, and that task deletes the line. This file should shrink. -->

- When a PR adds a CI workflow, check that every tool it runs (e.g. pytest) is installed by the dependency files the workflow installs from | count: 1 | last: 2026-10-23 | applies: kit adoption / any task adding .github/workflows
- Run safety guards on connection strings over the config the driver will actually use (query params like ?host= override the URL host) | count: 1 | last: 2026-10-26 | applies: applies: destructive test-DB helpers, env-gated DB tooling
- Database-name guards in test helpers don't protect roles (cluster-wide); use test-only role names or refuse if the role exists outside the test DB | count: 1 | last: 2026-10-26 | applies: applies: testdb.mjs and tests running ALTER ROLE / DROP ROLE
- An idempotency-key lookup must include soft-deleted rows whenever the unique constraint covers them | count: 1 | last: 2026-10-26 | applies: applies: any request_id/dedupe check on tables with deleted_at
- After a caught unique violation (23505) inside a transaction, further queries fail unless a SAVEPOINT or ON CONFLICT DO NOTHING is used | count: 1 | last: 2026-10-26 | applies: applies: Postgres write tools that turn constraint errors into CONFLICT
- Before comparing a naive TIMESTAMP's ::date to a local-date column, check the writer's timezone (Strava start_date is UTC) | count: 1 | last: 2026-10-26 | applies: applies: date joins across Strava/workout_summary and LA-day tables
- Do every input check that needs no database before guard.check (it consumes a rate-limit token) | count: 1 | last: 2026-10-26 | applies: applies: all write tools in tools/nutrition
- Day-summary or goal tools must cover days with no logged rows by working out goals from the goals table | count: 1 | last: 2026-10-26 | applies: applies: get_day_summary, readers of the nutrition_daily view
- notion-reporter/src/utils/db.mjs:79 and power_zone_graph.py:478 still group rides by UTC day (out of scope; planner to consider D8 follow-up). | count: 1 | last: 2026-10-26 | applies: general
- A runbook step that runs repo files (migrations, scripts) has to come after the step that puts those files on the host | count: 1 | last: 2026-10-26 | applies: applies: deploy runbooks and live-step docs
- When a decision re-specs an earlier task's spec files from a later task's T<n>-spec commit, per-task kit-gate for the earlier task fails; use kit-gate --all or teach task-gate.sh to honor newer spec commits on the same files | count: 1 | last: 2026-10-26 | applies: kit task-gate.sh / spec-integrity.sh per-task mode; plans with cross-task re-spec decisions (like D7)
- When a plan Decision says "also report X for comparison", check that the context object actually carries X, not just the primary figure | count: 1 | last: 2026-10-26 | applies: applies: prompt/context-builder tasks
- When a plan Decision defines a model shared by several modes (e.g. maintenance calibration), every mode's spec must either apply it or say why it doesn't | count: 1 | last: 2026-10-26 | applies: applies: planner and spec-writer for multi-mode features
- A runbook "check" step must not have side effects in production, and must match what the mode actually does in the code | count: 2 | last: 2026-10-27 | applies: applies: runbooks and smoke-test steps
- Cron instructions should be checked against the target OS's cron (CRON_TZ is cronie-only) and remove old lines by job, not by exact schedule | count: 1 | last: 2026-10-26 | applies: applies: Pi/cron runbooks
- When a scheduled report moves to run after the period it covers, derive titles and labels (week numbers, dates) from the reviewed period, not the run date | count: 1 | last: 2026-10-26 | applies: report/title builders when a Decision changes run day or review window (postReport.mjs formatWeeklyTitle)
- Test pools for a role with CONNECTION LIMIT n must set max <= n, or parallel queries fail intermittently | count: 1 | last: 2026-10-27 | applies: testdb.mjs role pools, dashboard integration tests
- Redact secrets and apply path-based headers with case-insensitive matching (Express 4 routes are case-insensitive by default) | count: 1 | last: 2026-10-27 | applies: any Express path-token redaction or path-prefix middleware
- When a task hardcodes a value that used to come from config, remove or rewire the config key in the same task so no setting is left that does nothing | count: 1 | last: 2026-10-27 | applies: dashboard config.mjs, any env-parsing module
- When a chart has a projection or reference line, extend the y-range to cover its visible end too, not just the data | count: 1 | last: 2026-10-27 | applies: chart option builders with plan, forecast or goal lines
- Prove a placeholder secret fails the real validator (run it or add a test); don't rely on a report saying so | count: 1 | last: 2026-10-27 | applies: env examples, config templates
- Runbook troubleshooting text must name the status codes and failure modes the code actually produces (e.g. startup exit vs 503), checked against the error paths in server/app code | count: 1 | last: 2026-10-27 | applies: deploy runbooks and README troubleshooting for services with startup checks
