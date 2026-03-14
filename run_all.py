"""
Full ETL pipeline for initial setup or recovery.

Run this once when setting up a new environment, or after a gap in
polling to backfill missing data.

Steps:
    1. Initialize DB schema (idempotent)
    2. Backfill all Strava workouts and stream samples
    3. Build workout summaries (NP, IF, TSS) for all workouts
"""

from health_data_hub.etl.init_db import initialize_database
from health_data_hub.etl.transform.backfill_strava import backfill_all
from health_data_hub.etl.transform.build_all_summaries import build_all_summaries


def main():
    print("Step 1: Initializing DB schema...")
    initialize_database()

    print("\nStep 2: Running Strava backfill...")
    backfill_all()

    print("\nStep 3: Building workout summaries...")
    build_all_summaries()

    print("\nAll ETL steps complete.")


if __name__ == "__main__":
    main()
