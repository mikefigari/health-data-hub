from datetime import date, timedelta
import time

from health_data_hub.integrations.oura.oura_api import (
    fetch_sleep,
    fetch_activity,
)

from health_data_hub.etl.extract.oura_extract import (
    extract_sleep_records,
    extract_readiness_records,
    extract_hr_samples,
    extract_activity_records,
)

from health_data_hub.etl.load.insert_oura_sleep import insert_oura_sleep
from health_data_hub.etl.load.insert_oura_readiness import insert_oura_readiness
from health_data_hub.etl.load.insert_oura_hr import insert_oura_hr
from health_data_hub.etl.load.insert_oura_activity import insert_oura_activity

from health_data_hub.utils.db_connect import get_connection


BACKFILL_DAYS = 60
SLEEP_BETWEEN_DAYS = 0.1  # keep polite but fast


def run_backfill():
    conn = get_connection()
    today = date.today()

    for i in range(BACKFILL_DAYS):
        day = today - timedelta(days=i + 1)
        next_day = day + timedelta(days=1)

        day_str = day.isoformat()
        next_day_str = next_day.isoformat()

        print(f"\n[Oura Backfill] {day_str}")

        # -----------------------------
        # Sleep / Readiness / HR
        # -----------------------------
        try:
            # Oura uses an exclusive end_date: [start_date, end_date)
            sleep_json = fetch_sleep(day_str, next_day_str)

            sleep_rows = extract_sleep_records(sleep_json)
            readiness_rows = extract_readiness_records(sleep_json)
            hr_rows = extract_hr_samples(sleep_json)

            if sleep_rows:
                insert_oura_sleep(conn, sleep_rows)
            if readiness_rows:
                insert_oura_readiness(conn, readiness_rows)
            if hr_rows:
                insert_oura_hr(conn, hr_rows)

            print(f"  ✓ sleep: {len(sleep_rows)}")
            print(f"  ✓ readiness: {len(readiness_rows)}")
            print(f"  ✓ hr samples: {len(hr_rows)}")

        except Exception as e:
            conn.rollback()
            print(f"  ✗ sleep/readiness/hr error: {e}")

        # -----------------------------
        # Activity
        # -----------------------------
        try:
            # Same exclusive end_date behavior
            activity_json = fetch_activity(day_str, next_day_str)
            activity_rows = extract_activity_records(activity_json)

            if activity_rows:
                insert_oura_activity(conn, activity_rows)

            print(f"  ✓ activity: {len(activity_rows)}")

        except Exception as e:
            conn.rollback()
            print(f"  ✗ activity error: {e}")

        time.sleep(SLEEP_BETWEEN_DAYS)

    conn.close()
    print("\nOura backfill complete.")


if __name__ == "__main__":
    run_backfill()
