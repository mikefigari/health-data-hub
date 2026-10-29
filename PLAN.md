# Plan: 1900 kcal goal from 2026-10-28, with a stored maintenance figure used by daily and weekly deficit math
Branch: orch/goal-1900-maintenance
> **Shelved (2026-10-28).** The goal change shipped by hand with an interim fixed maintenance of 2620 kcal + ride kJ in code (no migration, no `maintenance_calories` column). T1's spec test was removed because its migration was never built; Q7 in DECISIONS_NEEDED is moot. Revisit only if maintenance should be stored in `nutrition_goals`.
## Context
- Stack: Postgres (`health_data_hub/db/`), Node 22 ESM services `health-mcp/`, `notion-reporter/`, `dashboard/`. Unit tests: `cd <service> && npm test`. Integration: `cd <service> && TEST_DATABASE_URL=postgres://postgres@localhost:5433/hdh_test npm run test:integration` (private test cluster, never the Pi; shared harness `health-mcp/test/helpers/testdb.mjs`). Python tests: `venv/Scripts/python -m pytest -q`.
- Today: `goal_calories = base_calories + cycling_kj_factor * powered Ride kJ` (`health_data_hub/db/schema.sql:620-697`, view `nutrition_daily`). The weekly review uses `goal_calories` as maintenance (`notion-reporter/src/utils/nutritionWeek.mjs:48`), so with a 1900 goal it would report almost no deficit.
- New model: `maintenance_calories` on `nutrition_goals`; a day's maintenance = `maintenance_calories + round(cycling_kj_factor * ride kJ)`. Deficit for a day = day maintenance - calories eaten. Goal stays `base_calories + round(factor * kJ)`.
- Headless runs use `--permission-mode dontAsk`: run checks via `npm test`, `npm run <script>`, `node --test`, bare `npm install`.
- No-touch: the `nutrition_goals` row effective 2026-10-25 (goal fields), existing migrations, `health_data_hub/db/baseline/schema_2026-10.sql`, Oura/Strava pollers, `health_data_hub/etl/export_daily_json.py`.
## Decisions
- D1: Goal -> 1900 kcal base from 2026-10-28 (user chose A), as a NEW `nutrition_goals` row; protein 180 g and target weight 100.0 kg carry over.
- D2: Ride kJ -> factor stays 1.00; 1 kJ of powered Ride work = 1 kcal burned; it is added to both the day's goal and the day's maintenance in every daily and weekly equation.
- D3: Effective date -> 2026-10-28 (today).
- D4: Maintenance -> new `maintenance_calories` column; 2620 kcal/day (light activity, x1.375); recalculated by hand at milestones and check-ins by inserting a new goals row.
- D5: Scope -> the maintenance figure rolls into weekly metrics (weekly review, Thursday check-in, dashboard weekly averages), not only the daily view.
## Assumptions
- A1: Plan pace becomes 0.65 kg/week. 2620 - 1900 = 720 kcal/day = 5040 kcal/week = 0.655 kg at 7700 kcal/kg. The review's `on_track` test and projections would otherwise demand 825 kcal/day against a 720 kcal/day plan and flag every week off track. Default is 0.65 in `WEEKLY_LOSS_TARGET_KG` and `PLAN_KG_PER_WEEK`; deployed env overrides must be updated (live step in T7).
- A2: The 2026-10-25 row gets `maintenance_calories = 2620` in the migration (its own seed `base_calories`, which was maintenance when no deficit was applied). Its goal fields are not changed. Without this, days 10-25..10-27 would have no maintenance and the review would fall back to `goal_calories` for them.
- A3: `maintenance_calories` is `INT NOT NULL CHECK (BETWEEN 800 AND 6000)` after the backfill, same bounds as `base_calories`.
- A4: View `nutrition_daily` gets `maintenance_calories` appended as the LAST column (CREATE OR REPLACE VIEW only allows appended columns); legacy-table rows return `NULL::int`. Consumers fall back to `goal_calories` when it is null.
- A5: Days with no ride have kJ = 0, so maintenance = `maintenance_calories`.
- A6: The calibrated-maintenance path (scale trend, 28-day window, at least 21 usable days) stays as is; only its fallback figure and labels change.
## Default policy
- If ambiguous, follow the existing pattern in the file being edited and log the choice in the task's Notes.
- Null handling: `maintenance_calories ?? goal_calories` is the only fallback; never invent a number.
- Migration style: copy `health_data_hub/db/migrations/2026-11_03_dashboard_role.sql:1-16` (already-applied guard, ledger insert) and its `.down.sql`.
- Tests go beside existing ones (`test/unit`, `test/integration`); integration suites fail, not skip, without `TEST_DATABASE_URL`.
- New env vars: none. Defaults change only for `WEEKLY_LOSS_TARGET_KG` and `PLAN_KG_PER_WEEK`; README env tables are updated in the same task.
- Report needs-decision only for: user-visible behavior not covered above, data loss, security, cost, or a spec test that looks wrong.
## Tasks
### T1: Migration 2026-11_04 adds maintenance_calories, the 2026-10-28 goal row and the view column [model: sonnet] [risk: high] [status: needs-decision] [deps: none]
**Outcome**: After the migration, `nutrition_goals` has `maintenance_calories` (2620 on both rows), a new row effective 2026-10-28 has `base_calories` 1900, and `nutrition_daily.maintenance_calories` equals `maintenance_calories + round(factor * ride kJ)` for food_log days.
**Files**: `health_data_hub/db/migrations/2026-11_04_maintenance_calories.sql` (new; copy the guard/ledger pattern at `health_data_hub/db/migrations/2026-11_03_dashboard_role.sql:1-16`), `health_data_hub/db/migrations/2026-11_04_maintenance_calories.down.sql` (new), `health_data_hub/db/schema.sql` (mirror the table, seed rows and view at `:620-697` and the ledger insert at `:719`), `health-mcp/test/integration/maintenance_calories.int.test.mjs` (new; copy the harness use in `health-mcp/test/integration/nutrition_daily_view.int.test.mjs`)
**Non-goals**: no edit to the 2026-10-25 row's `base_calories`, `cycling_kj_factor`, `protein_g`, `target_weight_kg`; no change to the legacy table; no change to existing migrations.
**Acceptance tests**: `health-mcp/test/integration/maintenance_calories.int.test.mjs`: (a) fresh install and upgrade install both leave the `nutrition_daily` columns unchanged in order except a trailing `maintenance_calories`; (b) goals rows: 2026-10-25 keeps base 2620, factor 1.00, protein 180 and gains maintenance 2620; 2026-10-28 has base 1900, factor 1.00, protein 180, target 100.0, maintenance 2620; (c) a food_log day on 2026-10-27 with a 1000 kJ powered Ride has goal 3620 and maintenance 3620; a day on 2026-10-28 with the same ride has goal 2900 and maintenance 3620; a no-ride day on 2026-10-29 has goal 1900 and maintenance 2620; (d) a legacy-table day returns `maintenance_calories` NULL; (e) the migration refuses to run twice; (f) the `.down.sql` restores the previous view (no `maintenance_calories`), removes the 2026-10-28 row and drops the column, and `nutrition_writer` and `dashboard_ro` can still SELECT the view after up and after down; (g) an INSERT of a goals row with `maintenance_calories` 100 fails the CHECK.
**Done-when**: `cd health-mcp && TEST_DATABASE_URL=postgres://postgres@localhost:5433/hdh_test node --test --test-concurrency=1 test/integration/maintenance_calories.int.test.mjs test/integration/nutrition_daily_view.int.test.mjs test/integration/dashboard_role.int.test.mjs`
**Decision rule**: If a grant or role check in an older suite breaks, fix the migration, not the older suite; if an older suite pins the exact column list, report needs-decision.
**Notes**:

### T2: health-mcp day summary reports maintenance and deficit [model: sonnet] [risk: normal] [status: todo] [deps: T1]
**Outcome**: `get_day_summary` returns `goals.maintenance_calories` and `deficit_kcal`, and the no-rows branch returns goals plus maintenance from the goals table.
**Files**: `health-mcp/tools/nutrition/summary.mjs` (pattern at `:28-40` and `:90-130`), `health-mcp/test/integration/summary_maintenance.int.test.mjs` (new; copy `health-mcp/test/integration/summary_edit.int.test.mjs`), `health-mcp/README.md`
**Non-goals**: no change to write tools; `goal_calories` semantics unchanged.
**Acceptance tests**: `health-mcp/test/integration/summary_maintenance.int.test.mjs`: (a) a day with a 1000 kJ powered Ride and 2000 kcal eaten returns goals.calories 2900 (base 1900 + 1000, on or after 2026-10-28), goals.maintenance_calories 3620, deficit_kcal 1620; (b) a day with no rows (lesson: cover days with no logged rows from the goals table) returns goals.calories 1900 + ride kcal and maintenance_calories 2620 + ride kcal, totals null, deficit_kcal null; (c) a legacy day returns maintenance_calories null and deficit_kcal null; (d) the existing `summary_edit*.int.test.mjs` and `ride_day.int.test.mjs` still pass.
**Done-when**: `cd health-mcp && TEST_DATABASE_URL=postgres://postgres@localhost:5433/hdh_test node --test --test-concurrency=1 test/integration/summary_maintenance.int.test.mjs test/integration/summary_edit.int.test.mjs test/integration/summary_edit_review.int.test.mjs test/integration/ride_day.int.test.mjs && npm test`
**Decision rule**: Round kcal fields to integers; follow the `round1`/`num` helpers already in the file.
**Notes**:

### T3: Weekly deficit math measures against daily maintenance and plans 0.65 kg/week [model: sonnet] [risk: normal] [status: todo] [deps: none]
**Outcome**: `weeklyDeficit`, `thursdayCheck` and `calibratedMaintenance` use each row's `nutrition.maintenance_calories`, fall back to `goal_calories` when it is null, and the default loss target is 0.65 kg/week.
**Files**: `notion-reporter/src/utils/nutritionWeek.mjs` (edit `:8-12`, `:40-53`, `:128-151`), `notion-reporter/src/utils/buildCheckin.mjs` (map `maintenance_calories` at `:30-37`), `notion-reporter/test/unit/nutritionWeek.test.mjs`, `notion-reporter/test/unit/checkin.test.mjs`
**Non-goals**: no change to the calibration thresholds (21 days, 4 weigh-ins, 21 day span) or the 7700 kcal/kg constant.
**Acceptance tests**: `notion-reporter/test/unit/nutritionWeek.test.mjs`, `checkin.test.mjs`: (a) a row with calories 1900, maintenance_calories 2620, goal_calories 1900 gives deficit 720, not 0; (b) a row with maintenance_calories null falls back to goal_calories; (c) default `weeklyTargetKcal()` = round(0.65 * 7700) = 5005 and target_daily 715; an avg deficit of 720 is `on_track`, 700 is not; (d) `WEEKLY_LOSS_TARGET_KG=0.5` still overrides; (e) `weeklyDeficit` output includes `avg_maintenance` and `avg_calories` over usable days (integers, null when no data); (f) a ride day (maintenance 3620, calories 2900) contributes deficit 720; (g) Thursday check: Mon-Wed rows each with a 720 deficit give on_track true and post false, rows with a 400 deficit give post true and needed_per_day_thu_sun computed from the 5005 target; (h) a `maintenance` option passed in (calibrated) wins over row values; (i) `calibratedMaintenance` counts a row as usable when maintenance_calories or goal_calories is present and reports method 'daily_maintenance' (was 'goal_calories') when not calibrated.
**Done-when**: `cd notion-reporter && npm test`
**Decision rule**: Existing tests that pin 0.75 or 825 are re-specified here to the 0.65/715 values; do not keep both.
**Notes**:

### T4: Weekly context, DB inputs and analysis prompt carry maintenance [model: sonnet] [risk: normal] [status: todo] [deps: T1, T3]
**Outcome**: The nutrition rows fetched for the weekly review and exportDays include `maintenance_calories`, the weekly context reports `maintenance_method` 'daily_maintenance' or 'scale_calibrated', and the prompt text uses 0.65 kg/week and the new method name.
**Files**: `notion-reporter/src/utils/db.mjs` (`:100-110`, `:215-232`, `:247-270`), `notion-reporter/src/utils/buildWeeklyContext.mjs` (`:108-125`), `notion-reporter/src/anthropic/analyzeHealth.mjs` (`:127`, `:146`, `:179-191`), `notion-reporter/test/integration/nutrition_week_inputs.int.test.mjs`, `notion-reporter/test/unit/weekly_prompt.test.mjs`
**Non-goals**: no new Notion layout; no change to the calibrated estimate math.
**Acceptance tests**: `notion-reporter/test/integration/nutrition_week_inputs.int.test.mjs`, `notion-reporter/test/unit/weekly_prompt.test.mjs`: (a) `getNutritionWeekInputs` rows include `maintenance_calories` (number or numeric string); (b) the exportDays `nutrition` JSON object includes `maintenance_calories`; (c) `buildWeeklyContextFrom` with rows at maintenance 2620 and calories 1900 gives `nutritionWeek.avg_deficit` 720, `maintenance_method` 'daily_maintenance', and carries `avg_maintenance` (lesson: check the context object carries every figure the prompt asks to report); (d) when calibrated, `goal_model_avg_deficit` equals the daily-maintenance deficit; (e) the prompt contains "0.65 kg/week" and "daily_maintenance" and does not contain "0.75"; (f) rows with only goal_calories still build a context.
**Done-when**: `cd notion-reporter && TEST_DATABASE_URL=postgres://postgres@localhost:5433/hdh_test npm run test:integration && npm test`
**Decision rule**: Prompt wording changes only where it names the rate or method; the rest of the prompt text stays byte-identical.
**Notes**:

### T5: Dashboard data layer reports daily and weekly maintenance and deficit [model: sonnet] [risk: normal] [status: todo] [deps: T1]
**Outcome**: `buildDashboard` returns per-day `maintenance_calories`; per-week `avg_maintenance_calories` and `avg_deficit_kcal`; summary `avg_deficit_kcal`; goals include `maintenance_calories`; a missing nutrition-row maintenance falls back to the goals row plus `factor * ride kJ`.
**Files**: `dashboard/src/queries.mjs` (`:7-20`), `dashboard/src/aggregate.mjs` (`:76-83`, `:110-125`, `:145-190`, `:270-285`), `dashboard/src/demo.mjs` (`:29`, `:49`, `:67`), `dashboard/test/unit/aggregate.test.mjs`, `dashboard/test/integration/queries.int.test.mjs`
**Non-goals**: no UI edit (T6); `avg_balance_kcal` (calories - goal) stays and keeps its meaning.
**Acceptance tests**: `dashboard/test/unit/aggregate.test.mjs`, `dashboard/test/integration/queries.int.test.mjs`: (a) goals output includes `maintenance_calories` from the effective goals row; (b) a logged day with calories 1900 and row maintenance 2620 has `maintenance_calories` 2620 and deficit 720; (c) a ride day (1000 kJ, factor 1.0) with no row maintenance falls back to goals maintenance 2620 + 1000 = 3620; (d) week `avg_deficit_kcal` averages deficits over logged days only, `avg_maintenance_calories` likewise, both null with 0 logged days; (e) summary `avg_deficit_kcal` is over logged days with a maintenance figure; (f) days before any goals row have null maintenance and are excluded; (g) the queries return `maintenance_calories` for goals and nutrition rows; (h) demo inputs include `maintenance_calories` 2620 and stay deterministic.
**Done-when**: `cd dashboard && TEST_DATABASE_URL=postgres://postgres@localhost:5433/hdh_test npm run test:integration && npm test`
**Decision rule**: Round with the existing `r0`/`r1` helpers; follow the shape of `avg_goal_calories` when adding week fields.
**Notes**:

### T6: Dashboard shows the deficit and plans 0.65 kg/week [model: haiku] [risk: normal] [status: todo] [deps: T5]
**Outcome**: The calorie summary caption shows the average daily deficit, and the default plan pace is 0.65 kg/week in config, env example and README.
**Files**: `dashboard/public/js/core.mjs` (`:255-262`), `dashboard/src/config.mjs` (`:16`), `dashboard/dashboard.env.example` (`:13`), `dashboard/README.md` (env table `:51`), `dashboard/test/unit/core.test.mjs`, `dashboard/test/unit/app.test.mjs` (`:160`), `dashboard/test/unit/env-example.test.mjs`
**Non-goals**: no new chart; no new env var (lesson: when an env default changes, update the README table in the same task).
**Acceptance tests**: `dashboard/test/unit/core.test.mjs`, `app.test.mjs`, `env-example.test.mjs`, `config.test.mjs`: (a) the caption for `summary.avg_goal_calories` 1900, `avg_deficit_kcal` 720, 5 days logged reads exactly `Goal 1,900 · Deficit 720/day · 5 days logged` (thousands format follows `fmtInt`); (b) with `avg_deficit_kcal` null the caption is unchanged from today; (c) the `PLAN_KG_PER_WEEK` default is 0.65 in config, env example and README table; (d) an explicit `PLAN_KG_PER_WEEK=0.5` still overrides.
**Done-when**: `cd dashboard && npm test`
**Decision rule**: Keep the existing caption punctuation (middle dot); if the number format differs from `fmtInt`, follow `fmtInt` and adjust the test string.
**Notes**:

### T7: Docs and live steps for the goal change [model: haiku] [risk: normal] [status: todo] [deps: T1, T2, T3, T4, T5, T6]
**Outcome**: The docs state the maintenance formula, and the live steps run in an order that works (migration before any deploy).
**Files**: `docs/nutrition_logging.md` (`:66`), `docs/weekly-nutrition-review-runbook.md`, `docs/nutrition_deploy_runbook.md`
**Non-goals**: no code; no command that writes to production in a "check" step (lesson).
**Acceptance tests**: none: docs only. The Done-when greps are the check.
**Done-when**: `grep -q "maintenance_calories" docs/nutrition_logging.md && grep -q "2026-11_04_maintenance_calories" docs/nutrition_deploy_runbook.md && grep -q "0.65" docs/weekly-nutrition-review-runbook.md && ! grep -n "0\.75 kg" docs/weekly-nutrition-review-runbook.md`
**Decision rule**: Live-step order is: (1) copy repo files to the Pi, (2) apply migration 2026-11_04 to `health_pi`, (3) set `PLAN_KG_PER_WEEK=0.65` and `WEEKLY_LOSS_TARGET_KG=0.65` in the Pi env files if they were set to 0.75, (4) redeploy reporter and dashboard. Include how to add the next maintenance row (INSERT with a later `effective_from`) at a milestone.
**Notes**:
