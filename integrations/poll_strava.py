"""
Poll Strava every X minutes for new activities.

For each new workout:
  1. Insert into workouts_raw
  2. Fetch streams and insert into workout_samples
  3. Build workout_summary
  4. (Optionally run TSS update separately)
  5. Sync that exact workout to Notion
"""

# -------------------------------------------------------------------
# Bootstrapping (BAT, Task Scheduler, VSCode, Terminal)
# -------------------------------------------------------------------

import sys
from pathlib import Path

# Path to .../Programming/
PROJECT_PARENT = Path(__file__).resolve().parents[2]

# Add project parent so "health_data_hub.*" imports always work
if str(PROJECT_PARENT) not in sys.path:
    sys.path.insert(0, str(PROJECT_PARENT))

PROJECT_ROOT = PROJECT_PARENT / "health_data_hub"

print(">>> sys.path patched:", PROJECT_PARENT)

# -------------------------------------------------------------------
# Imports & environment
# -------------------------------------------------------------------

import time
from datetime import datetime, timezone

from dotenv import load_dotenv

load_dotenv(PROJECT_ROOT / "config" / "dev.env")

from health_data_hub.utils.db_connect import get_connection
from health_data_hub.etl.extract.strava_refresh import refresh_access_token
from health_data_hub.etl.extract.strava_api import (
    get_recent_activities,
    get_activity_streams,
)
from health_data_hub.etl.load.insert_workout import (
    insert_workout_metadata as insert_workout,
)
from health_data_hub.etl.load.insert_workout_samples import insert_workout_samples
from health_data_hub.etl.transform.build_workout_summary import build_summary_for
from health_data_hub.integrations.notion.notion_strava_sync import (
    sync_specific_workout,
)

# -------------------------------------------------------------------
# Config
# -------------------------------------------------------------------

POLL_INTERVAL = 300  # seconds (5 min)

# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

def parse_strava_ts(s: str):
    """Convert Strava ISO timestamp to UTC-aware datetime."""
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def get_last_synced_activity_time():
    """Return newest start_time from workouts_raw as tz-aware datetime."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT MAX(start_time) FROM workouts_raw;")
    ts = cur.fetchone()[0]
    cur.close()
    conn.close()

    if ts is None:
        return None

    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)

    return ts

# -------------------------------------------------------------------
# Single poll cycle
# -------------------------------------------------------------------

def poll_once():
    print("\n=== Poll cycle start ===\n")

    last_sync = get_last_synced_activity_time()
    print(f"[Poll] Last DB sync timestamp: {last_sync}")

    # Refresh token before hitting Strava API
    refresh_access_token()

    # Get recent activities (metadata only)
    activities = get_recent_activities(limit=30)

    # Attach parsed datetime to each activity
    for act in activities:
        act["_dt"] = parse_strava_ts(act.get("start_date_local"))

    # Process oldest -> newest
    activities.sort(
        key=lambda a: a["_dt"] or datetime.min.replace(tzinfo=timezone.utc)
    )

    found_new = False

    for act in activities:
        act_dt = act["_dt"]
        if act_dt is None:
            continue

        # Only process workouts newer than our last synced time
        if last_sync is None or act_dt > last_sync:
            print(f"→ New workout: {act['name']} @ {act_dt}")

            # 1) Insert raw → workouts_raw
            wid = insert_workout(act)
            print(f"[DB] Inserted raw workout id = {wid}")

            # 2) Fetch streams from Strava
            streams = None
            try:
                streams = get_activity_streams(act["id"])
            except Exception as e:
                print(f"[STRAVA] Failed to fetch streams for activity {act['id']}: {e}")

            # 3) Insert samples → workout_samples (safe if streams is None)
            try:
                insert_workout_samples(wid, streams)
            except Exception as e:
                print(f"[DB] Failed to insert samples for workout {wid}: {e}")

            # 4) Build summary → workout_summary
            try:
                build_summary_for(wid)
                print(f"[DB] Summary built for workout id = {wid}")
            except Exception as e:
                print(f"[DB] Failed to build summary for workout {wid}: {e}")

            # 5) Sync exactly this workout to Notion
            try:
                sync_specific_workout(wid)
                print(f"[Notion] Synced workout id = {wid}")
            except Exception as e:
                print(f"[Notion] Sync failed for id {wid}: {e}")

            found_new = True

    if not found_new:
        print("[Poll] No new workouts found.")

    print("\n=== Poll cycle complete ===\n")

# -------------------------------------------------------------------
# Continuous poll loop
# -------------------------------------------------------------------

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

# -------------------------------------------------------------------
# Entrypoint
# -------------------------------------------------------------------

if __name__ == "__main__":
    poll_loop()
