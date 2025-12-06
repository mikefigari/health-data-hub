"""
Poll Strava every X minutes for new activities.

Workflow:
    1. Insert into workouts_raw
    2. Insert into workout_samples
    3. Build workout_summary (NP, IF, TSS)
    4. Sync that workout to Notion
"""

import time
from datetime import datetime, timezone

from health_data_hub.utils.db_connect import get_connection
from health_data_hub.etl.extract.strava_refresh import refresh_access_token
from health_data_hub.etl.extract.strava_api import (
    get_recent_activities,
    get_activity_streams,
)
from health_data_hub.etl.load.insert_workout import insert_workout_metadata as insert_workout
from health_data_hub.etl.load.insert_workout_samples import insert_workout_samples
from health_data_hub.etl.transform.build_workout_summary import build_summary_for
from health_data_hub.integrations.notion.notion_strava_sync import sync_specific_workout

POLL_INTERVAL = 300  # 5 minutes


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
    print("\n=== Poll cycle start ===\n")

    last_sync = get_last_synced_activity_time()
    print(f"[Poll] Last DB sync timestamp: {last_sync}")

    # Refresh Strava OAuth token
    refresh_access_token()

    # Fetch recent activities
    activities = get_recent_activities(limit=30)

    for act in activities:
        act["_dt"] = parse_strava_ts(act.get("start_date_local"))

    activities.sort(
        key=lambda a: a["_dt"] or datetime.min.replace(tzinfo=timezone.utc)
    )

    found_new = False

    for act in activities:
        act_dt = act["_dt"]
        if act_dt is None:
            continue

        if last_sync is None or act_dt > last_sync:
            print(f"New workout: {act['name']} @ {act_dt}")

            # 1) Insert workouts_raw
            wid = insert_workout(act)
            print(f"[DB] Inserted raw workout id = {wid}")

            # 2) Insert workout_samples
            try:
                streams = get_activity_streams(act["id"])
            except Exception as e:
                print(f"[STRAVA] Stream fetch failed for activity {act['id']}: {e}")
                streams = None

            try:
                insert_workout_samples(wid, streams)
            except Exception as e:
                print(f"[DB] Sample insert failed for {wid}: {e}")

            # 3) Build summary row
            try:
                build_summary_for(wid)
                print(f"[DB] Summary built for workout {wid}")
            except Exception as e:
                print(f"[DB] Summary build failed for {wid}: {e}")

            # 4) Sync to Notion
            try:
                sync_specific_workout(wid)
                print(f"[Notion] Synced workout {wid}")
            except Exception as e:
                print(f"[Notion] Sync failed for {wid}: {e}")

            found_new = True

    if not found_new:
        print("[Poll] No new workouts found.")

    print("\n=== Poll cycle complete ===\n")


def poll_loop():
    print("=== Strava Poller Started ===")
    print(f"Polling every {POLL_INTERVAL} seconds...\n")

    while True:
        try:
            poll_once()
        except Exception as e:
            print(f"[ERROR] Poll cycle failed: {e}")

        print(f"Sleeping {POLL_INTERVAL} seconds...\n")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    poll_loop()
