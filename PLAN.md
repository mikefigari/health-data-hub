# Plan: Notion "Milestone progress" bar toward the next 100th Peloton ride
Branch: orch/milestone-progress-bar
## Context
- Stack: Python 3 package `health_data_hub/`, Notion via `notion_client.Client`. Tests: `venv/Scripts/python -m pytest -q` (no live DB or network; fake the Notion client with `MagicMock` like `tests/test_peloton_milestone.py:244`). Lint: `venv/Scripts/python -m ruff check .`.
- The ride number and the Notion write already exist: `set_notion_ride_number(notion, page_id, n)` at `health_data_hub/integrations/notion/peloton_milestone.py:93`. It is called from `notion_strava_sync.py:483-487` (upsert) and from `backfill()` at `peloton_milestone.py:144`. Both pick up any change made inside `set_notion_ride_number`, so no caller changes.
- The new Notion property is a Number named `Milestone progress`, value 0 to 1 (Notion shows it as a percent bar).
- No-touch: `health_data_hub/db/`, migrations, `.github/`, `.claude/`, env files, dashboard/, `notion_strava_sync.py`.
- Parallel: no
- Post-merge live steps (done by the planner, not the pipeline): (1) add the `Milestone progress` Number property (format percent) to the Notion workouts data source BEFORE the Pi runs the new code, because one `pages.update` carries all properties and fails if a property is missing; (2) the owner turns on Show as Bar in the property settings if the API cannot set it; (3) fill the last 10 rides (workout 916-925, rides 666-675) with their progress through the Notion MCP; (4) add a linked view of the workouts database on the Fitness page: sort date descending, limit 1, show only `Milestone progress`; (5) the owner pulls and restarts the Pi service.
## Decisions
- D1: Progress formula -> `((n - 1) % 100 + 1) / 100`. It equals `(n mod 100) / 100` except on a multiple of 100, where it gives 1.0 (full bar for the ride that reaches the milestone) instead of 0.0. Ride 675 gives 0.75, ride 700 gives 1.0, ride 701 gives 0.01.
- D2: Property name and range -> `Milestone progress`, a Number between 0 and 1.
- D3: Backfill scope -> last 10 rides, the same as the previous milestone backfill.
- D4: Existing behavior stays -> `Peloton #` and `Peloton Milestone` are written exactly as before, in the same single `pages.update` call.
## Assumptions
- A1: Showing 1.0 at the multiple of 100 (D1) is safe: the owner asked for a bar that fills to the next milestone, and a full bar at the milestone matches the "Ride 700" text.
- A2: The Notion API may not set "Show as Bar"; that display toggle is a one-time manual or UI step in the live steps, not code.
## Default policy
- If ambiguous, follow the existing pattern in `health_data_hub/integrations/notion/peloton_milestone.py:93` and log the choice in the task's Notes.
- Pure helper functions take and return plain numbers; the Notion call stays inside `set_notion_ride_number`.
- Tests fake Notion and the DB; never touch a live service.
- No new dependencies.
- Update the two existing tests that assert the exact `properties` dict, in the T1-spec commit.
- Report needs-decision only for: user-visible behavior not covered above, data loss, security, cost, or a spec test that looks wrong.
## Tasks
### T1: Write Milestone progress with the ride number [model: sonnet] [risk: normal] [review: tests] [status: done] [deps: none]
**Outcome**: `set_notion_ride_number` also sends `"Milestone progress": {"number": <0..1>}` in the same update call, so every new Peloton ride and every backfilled ride carries its progress toward the next 100th ride.
**Files**: `health_data_hub/integrations/notion/peloton_milestone.py` (add `milestone_progress(n)` beside `milestone_countdown` at `:74`; extend `props` in `set_notion_ride_number` at `:93`), `tests/test_peloton_milestone.py` (existing tests at `:244-260` assert the exact properties dict and must be updated in the T1-spec commit), `tests/test_milestone_progress.py` (new)
**Non-goals**: no change to ride-number counting, the email, `notion_strava_sync.py` or the offset; no Notion property creation in code; no change to `backfill()` signature.
**Acceptance tests**: `tests/test_milestone_progress.py`: `milestone_progress` returns 0.75 for 675, 0.01 for 701, 0.99 for 699, 1.0 for 700, 0.03 for 703, 0.5 for 650, and every value for n in 1..1000 lies in (0, 1]; `set_notion_ride_number(notion, "p1", 675)` sends properties with `"Milestone progress" == {"number": 0.75}` and `"Peloton #" == {"number": 675}` in one `pages.update` call; at 697 it sends progress 0.97 plus the unchanged "3 to 700" milestone text; at 700 it sends progress 1.0. `tests/test_peloton_milestone.py`: update the without-milestone test so it expects both `Peloton #` and `Milestone progress`, and keep the with-milestone assertions. Backfill calls `set_notion_ride_number`, so one backfill test checks each updated page receives a `Milestone progress` number.
**Done-when**: `venv/Scripts/python -m pytest -q tests/test_milestone_progress.py tests/test_peloton_milestone.py tests/test_notion_peloton_icon.py && venv/Scripts/python -m ruff check .`
**Decision rule**: if a float like 0.07 compares unequal, round to 2 decimals with `round(x, 2)` inside `milestone_progress` and test with that; follow D1 for the multiple of 100.
**Notes**:
Added `milestone_progress(n)` per D1, no rounding needed; sent in the same `pages.update`.
Add the Notion `Milestone progress` property before the Pi runs this code.
Metrics: attempts=1 fix=0 review=none blocked=none
