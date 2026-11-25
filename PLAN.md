# Plan: Peloton ride-count milestones (every 100th ride) with a 3-2-1 countdown
Branch: orch/peloton-milestones
## Context
- Stack: Python 3 package `health_data_hub/`, Postgres via `health_data_hub.utils.db_connect.get_connection`, Notion via `notion_client.Client` + `requests`. Tests: `venv/Scripts/python -m pytest -q` (no live DB or network in tests; fake `get_connection`, Notion and `send_alert` like `tests/test_notion_peloton_icon.py`). Lint: `venv/Scripts/python -m ruff check .`.
- New rides reach Notion through `sync_specific_workout(workout_id)` (`health_data_hub/integrations/notion/notion_strava_sync.py:556`). Its only callers are the Strava poller (`health_data_hub/integrations/poll_strava.py:233`) and the Strava webhook (`health_data_hub/integrations/strava_webhook.py:96`), both for newly inserted rides only. Bulk `sync_to_notion` (`:500`) is used for backfills.
- A ride is Peloton when `determine_tag(row) == "Peloton Bike"` (`notion_strava_sync.py:89`: elevation 0) and `_is_cycling_workout(row)` (`:108`).
- Email: `send_alert(subject, body)` in `health_data_hub/utils/alert.py:58`, never raises, suppresses a repeat of the same subject for 2 h.
- Data check 2026-11-24: in `notion_workouts_view`, workout_id 925 ("5 min Cool Down Ride with Jess King", 2026-11-24) is the 616th Peloton ride ordered by `(workout_date, workout_id)`; the owner's Peloton profile says 675. Offset = 59.
- No-touch: `health_data_hub/db/`, migrations, `.github/`, `.claude/`, env files, dashboard/.
- Parallel: no
## Decisions
- D1: Channel -> both: an email countdown, and a ride number on each Notion Peloton ride page.
- D2: Count basis -> match Peloton's own total: DB count + offset 59 (workout 925 = ride 675).
- D3: When to notify -> when the ride number is 3, 2 or 1 below the next multiple of 100, and on the multiple itself (697, 698, 699, 700; 797 … 800).
- D4: What is a Peloton ride -> the current rule: cycling sport type and elevation 0.
- D5: Past rides -> set the Notion number on the last 10 Peloton rides only (one-off backfill on the Pi). No emails for backfilled rides.
## Assumptions
- A1: The offset lives in `health_data_hub/config/settings.py` as `PELOTON_RIDE_OFFSET = int(os.getenv("PELOTON_RIDE_OFFSET", "59"))`, so no env-file change is needed on the Pi.
- A2: Notion properties: `Peloton #` (Number) on every Peloton ride, and `Peloton Milestone` (Text) only on countdown rides, e.g. "3 to 700" or "Ride 700 🎉". The planner creates both properties in the Notion workouts database as a live step after merge.
- A3: The ride number is computed as the count of Peloton rides with `(workout_date, workout_id) <= ` the target's, + offset, so a re-sync or backfill gives the same number. workout_id ties are safe because ids are inserted in ride order.
- A4: Emails fire only from `sync_specific_workout` (new rides), never from bulk sync or the backfill CLI. If both the poller and the webhook handle the same ride, the 2 h same-subject cooldown stops a second email.
- A5: Writing the Notion properties is its own `pages.update` call in a try/except, so a missing property logs a warning and never breaks the main workout sync.
## Default policy
- If ambiguous, follow the existing pattern in `notion_strava_sync.py:475-479` (Peloton-only side effect after the upsert, wrapped in try/except with `logger.warning`) and log the choice in the task's Notes.
- Logging: module `logger = logging.getLogger(__name__)`, no `print`. Any new `__main__` calls `setup_logging()` first (`notion_strava_sync.py:705-708`).
- Tests go in `tests/test_peloton_milestone.py`; fake the DB cursor, the Notion client and `send_alert`; no network.
- No new dependencies. No schema change or migration.
- Report needs-decision only for: user-visible behavior not covered above, data loss, security, cost, or a spec test that looks wrong.
## Tasks
### T1: Peloton ride number, countdown email and Notion number [model: sonnet] [risk: normal] [review: full] [status: done] [deps: none]
**Outcome**: Each new Peloton ride gets its Peloton ride number (DB count + 59) written to Notion `Peloton #`; rides 3, 2 and 1 short of a multiple of 100, and the multiple itself, also get `Peloton Milestone` text and one email; a CLI sets the number on the last N Peloton rides without emailing.
**Files**:
- `health_data_hub/integrations/notion/peloton_milestone.py` (new). Public interface:
  - `peloton_ride_number(workout_id: int) -> int | None`: one SQL query on `notion_workouts_view`. Returns None when the target row is missing or not Peloton (elevation_meters = 0 AND `lower(replace(coalesce(sport_type,''),' ',''))` in the `CYCLING_SPORT_TYPES` set or ending in `ride`, mirroring `notion_strava_sync.py:56` and `:108`). Otherwise returns the count of Peloton rows with `(workout_date, workout_id) <= (target's)` + `PELOTON_RIDE_OFFSET`. Close the connection in `finally` (pattern `notion_strava_sync.py:360-376`).
  - `milestone_countdown(n: int) -> tuple[int, int] | None`: `(next_milestone, remaining)` with next_milestone = the smallest multiple of 100 >= n; returns None unless remaining is 0..3. Examples: 697 -> (700, 3); 699 -> (700, 1); 700 -> (700, 0); 696 -> None; 701 -> None; 675 -> None.
  - `milestone_text(n) -> str | None`: "3 to 700" / "2 to 700" / "1 to 700" / "Ride 700 🎉"; None outside the window.
  - `set_notion_ride_number(notion, page_id, n) -> None`: one `notion.pages.update` with `Peloton #` = n and, when `milestone_text(n)` is not None, `Peloton Milestone` = that text.
  - `notify_milestone(n) -> None`: when in the window, `send_alert` with subject `Peloton: 3 rides to 700 (ride 697)` (and 2/1 forms, "1 ride to") or `Peloton: ride 700 milestone!` for remaining 0, plus a one-line body; does nothing outside the window.
  - `backfill(last_n: int = 10) -> int`: for the last `last_n` Peloton rides by `(workout_date, workout_id)`, find the Notion page (`_find_page_id`, `notion_strava_sync.py:412`) and call `set_notion_ride_number`; never calls `send_alert`; returns the number of pages updated. `__main__`: `setup_logging()`, then argparse `--last N` (default 10), `--dry-run` (log the numbers, no Notion writes).
- `health_data_hub/integrations/notion/notion_strava_sync.py`: in `upsert_workout` (`:451`), after the Peloton icon block (`:475-479`), for Peloton cycling rides compute `peloton_ride_number` and call `set_notion_ride_number` inside try/except -> `logger.warning`. In `sync_specific_workout` (`:556`) only, after the upsert, call `notify_milestone` for Peloton rides inside try/except. Do not change `build_properties`. Avoid a circular import (import the helpers inside the functions, or keep `peloton_milestone.py` free of imports from `notion_strava_sync` except `_find_page_id` imported inside `backfill`).
- `health_data_hub/config/settings.py` (Notion block at `:81-85`): add `PELOTON_RIDE_OFFSET` per A1.
- `tests/test_peloton_milestone.py` (spec writer).
**Non-goals**: no dashboard card, no DB schema change, no Notion property creation in code, no emails from `sync_to_notion` or the backfill, no change to `determine_tag`.
**Acceptance tests**: `tests/test_peloton_milestone.py`:
(a) `milestone_countdown` and `milestone_text` for 675, 696, 697, 698, 699, 700, 701, 797, 800 per the examples above;
(b) `PELOTON_RIDE_OFFSET` defaults to 59 when the env var is unset, and `peloton_ride_number` adds it to the count the faked cursor returns (616 -> 675) and returns None when the faked cursor reports a non-Peloton or missing row;
(c) `notify_milestone(698)` calls the faked `send_alert` once with subject `Peloton: 2 rides to 700 (ride 698)`; `notify_milestone(699)` uses "1 ride to 700"; `notify_milestone(700)` uses `Peloton: ride 700 milestone!`; `notify_milestone(696)` and `(701)` do not call it;
(d) `set_notion_ride_number(fake, "p1", 697)` sends `Peloton #` 697 and `Peloton Milestone` "3 to 700"; for 675 it sends only `Peloton #`;
(e) `upsert_workout` for a Peloton row calls `set_notion_ride_number` with the computed number, and a Garmin row (elevation 350) does not; when `set_notion_ride_number` raises, `upsert_workout` still returns the page id and logs a warning;
(f) `sync_specific_workout` on a Peloton row at ride 699 calls `send_alert` once; `sync_to_notion` over the same row calls `send_alert` zero times;
(g) `backfill(last_n=2)` with two faked rides updates two pages and never calls `send_alert`; `--dry-run` makes no `pages.update` call;
(h) the existing `tests/test_notion_peloton_icon.py` still passes unchanged.
**Done-when**: `venv/Scripts/python -m pytest -q && venv/Scripts/python -m ruff check health_data_hub tests`
**Decision rule**: if the existing icon tests break because `upsert_workout` now queries the DB, patch `peloton_ride_number` in those tests' setup only by adding a fixture in the new test module, never by editing `tests/test_notion_peloton_icon.py`; if that is impossible, report needs-decision.
**Notes**: `notion_strava_sync.py` imports `peloton_milestone` inside functions (no circular import). `backfill` takes an extra `dry_run` flag used by `--dry-run`.
Metrics: attempts=1 fix=0 review=PASS blocked=none

## Live steps (planner, after merge — self-verified)
1. In the Notion workouts database (`NOTION_WORKOUT_DB_ID`), add properties `Peloton #` (Number) and `Peloton Milestone` (Text). Check: fetch the database schema and confirm both exist.
2. On the Pi: `git pull --ff-only` in the health-data-hub checkout, restart `health-data-hub`. Check: service active, journal shows no import error.
3. On the Pi: `venv/bin/python -m health_data_hub.integrations.notion.peloton_milestone --last 10 --dry-run`, then without `--dry-run`. Check: workout 925 logs ride 675, and its Notion page shows `Peloton #` 675; rollback = clear the two properties on those 10 pages.
