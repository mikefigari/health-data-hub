"""Peloton ride number, milestone countdown email and Notion number.

The ride number matches Peloton's own total: DB count of Peloton rides up to
and including the target (ordered by workout_date, workout_id) + offset.
"""
from __future__ import annotations

import argparse
import logging

from notion_client import Client

from health_data_hub.config.settings import (
    NOTION_TOKEN,
    NOTION_WORKOUT_DB_ID,
    PELOTON_RIDE_OFFSET,
)
from health_data_hub.utils.alert import send_alert
from health_data_hub.utils.db_connect import get_connection

logger = logging.getLogger(__name__)

NOTION_SDK_VERSION = "2022-06-28"

# Mirrors notion_strava_sync.CYCLING_SPORT_TYPES / _is_cycling_workout.
_SPORT_NORM = "lower(replace(coalesce({a}sport_type, ''), ' ', ''))"


def _peloton_cond(alias: str) -> str:
    prefix = f"{alias}." if alias else ""
    norm = _SPORT_NORM.format(a=prefix)
    return (
        f"({prefix}elevation_meters = 0 AND ("
        f"{norm} IN ('ride','virtualride','ebikeride','handcycleride','gravelride') "
        f"OR {norm} LIKE '%%ride'))"
    )


_RIDE_NUMBER_SQL = f"""
WITH target AS (
    SELECT workout_date, workout_id
    FROM notion_workouts_view
    WHERE workout_id = %s AND {_peloton_cond("")}
)
SELECT count(*)
FROM notion_workouts_view v, target t
WHERE {_peloton_cond("v")}
  AND (v.workout_date, v.workout_id) <= (t.workout_date, t.workout_id)
"""

_LAST_RIDES_SQL = f"""
SELECT workout_id, workout_date
FROM notion_workouts_view
WHERE {_peloton_cond("")}
ORDER BY workout_date DESC, workout_id DESC
LIMIT %s
"""


def peloton_ride_number(workout_id: int) -> int | None:
    """Peloton ride number for a workout, or None if missing / not Peloton."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(_RIDE_NUMBER_SQL, (workout_id,))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row or row[0] is None or row[0] == 0:
        return None
    return int(row[0]) + PELOTON_RIDE_OFFSET


def milestone_countdown(n: int) -> tuple[int, int] | None:
    """(next_milestone, remaining) when n is 0..3 short of a multiple of 100."""
    nxt = -(-n // 100) * 100
    remaining = nxt - n
    if 0 <= remaining <= 3:
        return nxt, remaining
    return None


def milestone_text(n: int) -> str | None:
    cd = milestone_countdown(n)
    if cd is None:
        return None
    nxt, remaining = cd
    if remaining == 0:
        return f"Ride {nxt} \U0001F389"
    return f"{remaining} to {nxt}"


def set_notion_ride_number(notion, page_id: str, n: int) -> None:
    props: dict = {"Peloton #": {"number": n}}
    text = milestone_text(n)
    if text is not None:
        props["Peloton Milestone"] = {"rich_text": [{"text": {"content": text}}]}
    notion.pages.update(page_id=page_id, properties=props)


def notify_milestone(n: int) -> None:
    cd = milestone_countdown(n)
    if cd is None:
        return
    nxt, remaining = cd
    if remaining == 0:
        subject = f"Peloton: ride {nxt} milestone!"
        body = f"Ride {nxt} is in the books. Congratulations!"
    else:
        noun = "ride" if remaining == 1 else "rides"
        subject = f"Peloton: {remaining} {noun} to {nxt} (ride {n})"
        body = f"Ride {n} is synced. {remaining} more {noun} until ride {nxt}."
    send_alert(subject, body)


def backfill(last_n: int = 10, dry_run: bool = False) -> int:
    """Set the Notion number on the last N Peloton rides. Never emails."""
    from health_data_hub.integrations.notion.notion_strava_sync import _find_page_id

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(_LAST_RIDES_SQL, (last_n,))
            rows = cur.fetchall()
    finally:
        conn.close()

    notion = None if dry_run else Client(auth=NOTION_TOKEN, notion_version=NOTION_SDK_VERSION)
    updated = 0
    for row in rows:
        wid = row[0]
        n = peloton_ride_number(wid)
        if n is None:
            logger.warning(f"[Peloton] Workout {wid} has no ride number; skipping")
            continue
        if dry_run:
            logger.info(f"[Peloton] DRY RUN workout {wid} -> ride {n}")
            updated += 1
            continue
        page = _find_page_id(notion, NOTION_WORKOUT_DB_ID, wid)
        if not page:
            logger.warning(f"[Peloton] No Notion page for workout {wid}; skipping")
            continue
        set_notion_ride_number(notion, page["id"], n)
        logger.info(f"[Peloton] Workout {wid} -> ride {n}")
        updated += 1
    return updated


if __name__ == "__main__":
    from health_data_hub.utils.logging_config import setup_logging

    setup_logging()
    parser = argparse.ArgumentParser(description="Backfill Peloton ride numbers in Notion")
    parser.add_argument("--last", type=int, default=10)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    count = backfill(args.last, dry_run=args.dry_run)
    logger.info(f"[Peloton] Done: {count} rides")
