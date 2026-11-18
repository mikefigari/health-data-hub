# Plan: Dashboard Weight card shows the day of the weigh-in and the change since the last one
Branch: orch/weight-today
## Context
- Stack: Node dashboard in `dashboard/` (Express + ECharts). Weight data comes from `body_weight_daily` (first weigh-in of each local day) via `dashboard/src/queries.mjs:5`; `buildDashboard` in `dashboard/src/aggregate.mjs:231-309` builds `weight.{current_kg,last_weigh_in_day,days_since_weigh_in,...}`.
- The Weight card hero number is already the raw scale reading (`cardStat` case `'weight'`, `dashboard/public/js/core.mjs:275`; `weightHero` at `dashboard/public/js/charts/weight.mjs:142`). Its caption is built by `weightCaption` (`core.mjs:184`).
- Tests: `cd dashboard && npm test` (node --test, `test/unit/`). No database or migration work. Lint: `venv/Scripts/python -m ruff check . && node scripts/check-unused-exports.mjs`.
- No-touch: `dashboard/src/queries.mjs`, anything under `health_data_hub/db/`, `.claude/`, `.github/`, Docker files.
- Parallel: no.
## Decisions
- D1: Which reading is "today's weight"? -> The first weigh-in of the day, which is the existing `body_weight_daily` row. The user weighs once a day, so first equals latest and no query change is needed.
- D2: Where does it appear? -> Only on the Weight card (the existing hero number), relabelled with the day. No new Today-view tile.
- D3: What when there is no weigh-in today? -> Show the most recent weigh-in with its age: "3 days ago · Nov 15".
- D4: Extra motivation? -> A change line against the previous weigh-in ("▼ 0.4 kg vs yesterday"). No "new low" badge.
## Assumptions
- A1: Units are kg, as everywhere on the dashboard.
- A2: "Previous weigh-in" means the closest earlier day with a reading. If that day is not yesterday, the label names the date ("vs Nov 12") instead of "vs yesterday", so the line is never misleading after a gap.
- A3: Existing caption pieces (`Trend X`, range change) stay, appended after the new text, so existing `includes` assertions in `charts-weight.test.mjs:203` keep passing.
## Default policy
- If ambiguous, follow the existing pattern in `dashboard/public/js/core.mjs:183-189` (`weightCaption`) and log the choice in the task's Notes.
- Format with the existing helpers `fmtKg`, `fmtDay` and the `MINUS` constant in `core.mjs`. No new dependencies.
- Compute the delta from unrounded kg and decide "no change" from the 1-decimal rounded value, so the arrow always agrees with the number shown.
- New fields go in the `weight` object returned by `buildDashboard`; the front end never recomputes dates.
- Report needs-decision only for: user-visible behavior not covered above, data loss, security, cost, or a spec test that looks wrong.
## Tasks
### T1: Weight card labels the weigh-in day and shows the change since the previous weigh-in [model: sonnet] [risk: normal] [review: tests] [status: todo] [deps: none]
**Outcome**: The Weight card caption starts with the weigh-in's day ("Today", "Yesterday", or "3 days ago · Nov 15") followed by a change line ("▼ 0.4 kg vs yesterday", "▲ 0.3 kg vs Nov 12", or "No change vs yesterday"), then the existing Trend and range-change text.
**Files**: `dashboard/src/aggregate.mjs` (add `prev_weigh_in_day`, `prev_kg`, `change_vs_prev_kg` to the `weight` object near line 301, copying how `last_weigh_in_day` is computed at line 303), `dashboard/public/js/core.mjs` (extend `weightCaption` at line 184 and the `'weight'` case at line 275), `dashboard/test/unit/aggregate.test.mjs` (new cases beside line 246), `dashboard/test/unit/charts-weight.test.mjs` (new cases beside line 203)
**Non-goals**: No SQL or `queries.mjs` change. No new tile on the Today view. No "new low" badge. No change to the chart, trend or roadmap maths.
**Acceptance tests**: `dashboard/test/unit/aggregate.test.mjs`: (a) weigh-ins on today and yesterday give `prev_weigh_in_day` = yesterday, `change_vs_prev_kg` = today minus yesterday rounded to 1 decimal; (b) a gap (previous reading 3 days earlier) keeps `prev_weigh_in_day` = that day; (c) a single weigh-in gives null for all three new fields. `dashboard/test/unit/charts-weight.test.mjs`: (d) weigh-in today + loss: caption starts with `Today`, contains `▼ 0.4 kg vs yesterday`, still contains `Trend` and `30 days`; (e) weigh-in 3 days old: caption starts with `3 days ago · ` plus the `fmtDay` date; (f) gain gives `▲`; (g) a change that rounds to 0.0 shows `No change` and no arrow; (h) previous reading not yesterday names its date after `vs`; (i) no previous reading omits the change line; (j) no data keeps the existing `Last 30 days` fallback.
**Done-when**: `cd dashboard && npm test`
**Decision rule**: If wording or symbols are ambiguous, copy the style of `fmtSigned` (`core.mjs:112`) and the `MINUS` glyph; log the choice in Notes.
**Notes**:
