"""
One-off helper: backfill streams + TSS for workout_id = 715
"""

import sys
from pathlib import Path

# --- Bootstrapping like poll_strava.py ---

PROJECT_PARENT = Path(__file__).resolve().parents[1]
if str(PROJECT_PARENT) not in sys.path:
    sys.path.insert(0, str(PROJECT_PARENT))

PROJECT_ROOT = PROJECT_PARENT / "health_data_hub"
print(">>> sys.path patched:", PROJECT_PARENT)

from dotenv import load_dotenv
load_dotenv(PROJECT_ROOT / "config" / "dev.env")

from health_data_hub.etl.extract.strava_api import get_activity_streams
from health_data_hub.etl.load.insert_workout_samples import insert_workout_samples
from health_data_hub.etl.transform.update_tss import update_tss


WORKOUT_ID = 715          # DB id
STRAVA_ID  = 16556070068  # the Strava activity id you gave me


def main():
    print(f"Backfilling samples for workout_id={WORKOUT_ID}, strava_id={STRAVA_ID}")

    # 1) Fetch streams from Strava
    streams = get_activity_streams(STRAVA_ID)
    if streams is None:
        print("No streams returned from Strava; cannot backfill.")
        return

    # 2) Insert into workout_samples
    insert_workout_samples(WORKOUT_ID, streams)

    # 3) Recompute TSS for ALL workouts (cheap + idempotent)
    update_tss()

    print("Backfill complete. Check workout_summary for workout_id=715.")


if __name__ == "__main__":
    main()
