"""
Poll Strava every X minutes for new activities.
Insert new activities into Postgres (workouts_raw + samples + summary).
Then sync the newest workout to Notion.
"""

import time
from pathlib import Path
import os
from datetime import datetime

from dotenv import load_dotenv

from etl.extract.strava_api import get_recent_activities
from etl.extract.strava_refresh import refresh_access_token
from etl.load.insert_workout import insert_workout
from integrations.notion.notion_strava_sync import sync_single_newest
from utils.db_connect import get_connection


# -------------------------------------------------------------------
# Env + Config
# -------------------------------------------------------------------

ENV_PATH = Path(__file__).resolve().parents[2] / "config" / "dev.env"
load_dotenv(ENV_PATH)

POLL_INTERVAL = 300  # 5 minutes


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

def get_last_synced_activity_time():
    """Return the latest start_time we have stored in workouts_raw."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT MAX(start_time) FROM workouts_raw;")
    timestamp = cur.fetchone()[0]
    cur.close()
    conn.close()
    return timestamp


# -------------------------------------------------------------------
# Poll Loop
# -------------------------------------------------------------------

def poll_loop():
    print("=== Strava Poller Started ===")
    print(f"Polling every {POLL_INTERVAL} seconds...\n")

    while True:
        try:
            last_sync = get_last_synced_activity_time()
            print(f"[Poll] Last DB sync timestamp: {last_sync}")

            # Refresh Strava token
            refresh_access_token()

            # Fetch recent activities from Strava
            activities = get_recent_activities(limit=30)

            # Ensure newest → oldest
            activities.sort(key=lambda a: a["start_date_local"])

            new_workout_found = False

            for act in activities:
                act_start = act["start_date_local"]  # already a datetime from Strava lib

                if last_sync is None or act_start > last_sync:
                    print(f"\n→ New workout detected: {act['name']} @ {act_start}")
                    insert_workout(act)
                    sync_single_newest()
                    new_workout_found = True

            if not new_workout_found:
                print("[Poll] No new workouts.")

        except Exception as e:
            print(f"[ERROR] Poll cycle failed: {e}")

        print(f"Sleeping {POLL_INTERVAL} seconds...\n")
        time.sleep(POLL_INTERVAL)


# -------------------------------------------------------------------
# Entrypoint
# -------------------------------------------------------------------

if __name__ == "__main__":
    poll_loop()
