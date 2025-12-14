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
SLEEP_BETWEEN_DAYS = 1  # seconds


def run_backfill():
    conn = get_connection()
    today = date.today()

    for i in range(BACKFILL_DAYS):
        day = today - timedelta(days=i + 1)
        day_str = day.isoformat()

        print(f"\n[Oura Backfill] {day_str}")

        try:
            sleep_json = fetch_sleep(day_str, day_str)
            sleep_rows = extract_sleep_records(sleep_json)
            readiness_rows = extract_readiness_records(sleep_json)
            hr_rows = extract_hr_samples(sleep_json)

            insert_oura_sleep(conn, sleep_rows)
            insert_oura_readiness(conn, readiness_rows)
            insert_oura_hr(conn, hr_rows)

            print(f"  ✓ sleep: {len(sleep_rows)}")
            print(f"  ✓ readiness: {len(readiness_rows)}")
            print(f"  ✓ hr samples: {len(hr_rows)}")

        except Exception as e:
            print(f"  ✗ sleep/readiness/hr failed: {e}")

        try:
            activity_json = fetch_activity(day_str, day_str)
            activity_rows = extract_activity_records(activity_json)

            insert_oura_activity(conn, activity_rows)

            print(f"  ✓ activity: {len(activity_rows)}")

        except Exception as e:
            print(f"  ✗ activity failed: {e}")

        time.sleep(SLEEP_BETWEEN_DAYS)

    conn.close()
    print("\nOura 60-day backfill complete.")


if __name__ == "__main__":
    run_backfill()
