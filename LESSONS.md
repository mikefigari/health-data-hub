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
