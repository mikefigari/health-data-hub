"""
Poll Strava every X minutes for new activities.

Workflow:
    1. Insert into workouts_raw
    2. Insert into workout_samples
    3. Build workout_summary (NP, IF, TSS)
    4. Sync that workout to Notion
"""

import logging
import time
import traceback
from datetime import datetime, timezone

from health_data_hub.utils.db_connect import get_connection
from health_data_hub.etl.extract.strava_refresh import get_valid_access_token
from health_data_hub.etl.extract.strava_api import (
    get_recent_activities,
    get_activity_streams,
)
from health_data_hub.etl.load.insert_workout import insert_workout_metadata as insert_workout
from health_data_hub.etl.load.insert_workout_samples import insert_workout_samples
from health_data_hub.etl.transform.build_workout_summary import build_summary_for
from health_data_hub.integrations.notion.notion_strava_sync import sync_specific_workout

logger = logging.getLogger(__name__)

POLL_INTERVAL = 300  # 5 minutes


# -------------------------------------------------------------------
# Sync log
# -------------------------------------------------------------------

def _write_sync_log(status: str, activities_found: int = None,
                    activities_written: int = None, error_message: str = None):
    """Write one row to strava_sync_log.  Never raises — log errors are non-fatal."""
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO strava_sync_log
                (status, activities_found, activities_written, error_message)
            VALUES (%s, %s, %s, %s)
            """,
            (status, activities_found, activities_written, error_message),
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.error("Failed to write strava_sync_log: %s", e)


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

def parse_strava_ts(s: str):
    """Convert Strava ISO timestamp to aware datetime."""
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def get_last_synced_activity_time():
    """Return newest start_time from workouts_raw."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT MAX(start_time) FROM workouts_raw;")
    ts = cur.fetchone()[0]
    cur.close()
    conn.close()

    if ts is None:
        return None

    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


# -------------------------------------------------------------------
# Poll cycle
# -------------------------------------------------------------------

def poll_once():
    logger.info("=== Poll cycle start ===")

    last_sync = get_last_synced_activity_time()
    logger.info("Last DB sync timestamp: %s", last_sync)

    logger.info("Checking Strava OAuth token...")
    try:
        access_token = get_valid_access_token()
    except Exception as e:
        _write_sync_log("error", error_message=f"Token refresh failed: {e}")
        raise

    logger.info("Fetching recent activities...")
    try:
        activities = get_recent_activities(access_token, limit=30)
    except Exception as e:
        _write_sync_log("error", error_message=f"API fetch failed: {e}")
        raise

    for act in activities:
        act["_dt"] = parse_strava_ts(act.get("start_date_local"))

    activities.sort(
        key=lambda a: a["_dt"] or datetime.min.replace(tzinfo=timezone.utc)
    )

    found_new = False
    written = 0

    for act in activities:
        act_dt = act["_dt"]
        if act_dt is None:
            continue

        if last_sync is None or act_dt > last_sync:
            logger.info("New workout: %s @ %s", act["name"], act_dt)

            # 1) Insert workouts_raw
            wid = insert_workout(act)
            logger.info("Inserted raw workout id=%s", wid)

            # 2) Insert workout_samples
            try:
                streams = get_activity_streams(access_token, act["id"])
            except Exception as e:
                logger.warning("Stream fetch failed for activity %s: %s", act["id"], e)
                streams = None

            try:
                insert_workout_samples(wid, streams)
            except Exception as e:
                logger.error("Sample insert failed for workout %s: %s", wid, e)

            # 3) Build summary row
            try:
                build_summary_for(wid)
                logger.info("Summary built for workout %s", wid)
            except Exception as e:
                logger.error("Summary build failed for workout %s: %s", wid, e)

            # 4) Sync to Notion
            try:
                sync_specific_workout(wid)
                logger.info("Notion sync complete for workout %s", wid)
            except Exception as e:
                logger.error("Notion sync failed for workout %s: %s", wid, e)

            found_new = True
            written += 1

    if not found_new:
        logger.info("No new workouts found.")
        _write_sync_log("no_data", activities_found=len(activities), activities_written=0)
    else:
        _write_sync_log("success", activities_found=len(activities), activities_written=written)

    logger.info("=== Poll cycle complete ===")


def poll_loop():
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()

    logger.info("=== Strava Poller Started ===")
    logger.info("Polling every %s seconds", POLL_INTERVAL)

    while True:
        try:
            poll_once()
        except Exception as e:
            logger.error("Poll cycle failed: %s", e, exc_info=True)

        logger.info("Sleeping %s seconds...", POLL_INTERVAL)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    poll_loop()
