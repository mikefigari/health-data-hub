"""
Polls Oura API for recent sleep, readiness, activity, and HR samples.
Safe to run every 10 minutes.

Location:
    health_data_hub/integrations/oura/poll_oura.py
"""

from datetime import date, timedelta
import traceback

# Local import (same folder)
from .oura_api import fetch_sleep, fetch_activity

# Extract layer
from health_data_hub.etl.extract.oura_extract import (
    extract_sleep_records,
    extract_readiness_records,
    extract_hr_samples,
    extract_activity_records
)

# Load layer
from health_data_hub.etl.load.insert_oura_sleep import insert_oura_sleep
from health_data_hub.etl.load.insert_oura_readiness import insert_oura_readiness
from health_data_hub.etl.load.insert_oura_activity import insert_oura_activity
from health_data_hub.etl.load.insert_oura_hr import insert_oura_hr

# DB connection
from health_data_hub.utils.db_connect import get_connection


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _date_range(days_back: int = 3):
    """
    Returns (start_date, end_date) as ISO strings.
    We go back 3 days because Oura finalizes sleep late.
    """
    today = date.today()
    start = today - timedelta(days=days_back)
    return start.isoformat(), today.isoformat()


# ---------------------------------------------------------------------------
# Main Poller
# ---------------------------------------------------------------------------

def poll_oura():
    print("=== Oura Poller Started ===")

    start_date, end_date = _date_range(days_back=3)
    print(f"Fetching Oura data for {start_date} → {end_date}")

    conn = get_connection()

    try:
        # ---------------------------------------------------------
        # 1. Sleep (includes readiness + HR blocks)
        # ---------------------------------------------------------
        print("Fetching sleep data...")
        sleep_json = fetch_sleep(start_date, end_date)

        sleep_rows = extract_sleep_records(sleep_json)
        readiness_rows = extract_readiness_records(sleep_json)
        hr_rows = extract_hr_samples(sleep_json)

        print(f" Sleep records parsed: {len(sleep_rows)}")
        print(f" Readiness records parsed: {len(readiness_rows)}")
        print(f" HR sample rows parsed: {len(hr_rows)}")

        inserted_sleep = insert_oura_sleep(conn, sleep_rows)
        inserted_readiness = insert_oura_readiness(conn, readiness_rows)

        # HR samples have composite key — ensure index exists
        inserted_hr = insert_oura_hr(conn, hr_rows)

        print(f" Inserted/updated sleep: {inserted_sleep}")
        print(f" Inserted/updated readiness: {inserted_readiness}")
        print(f" Inserted/updated HR samples: {inserted_hr}")

        # ---------------------------------------------------------
        # 2. Daily Activity (summary only — avoids workout duplication)
        # ---------------------------------------------------------
        print("Fetching daily activity...")
        activity_json = fetch_activity(start_date, end_date)
        activity_rows = extract_activity_records(activity_json)

        print(f" Activity rows parsed: {len(activity_rows)}")

        inserted_activity = insert_oura_activity(conn, activity_rows)
        print(f" Inserted/updated activity rows: {inserted_activity}")

        print("=== Oura Poller Completed Successfully ===")

    except Exception as e:
        print("ERROR during Oura polling:")
        print(str(e))
        traceback.print_exc()

    finally:
        conn.close()


# ---------------------------------------------------------------------------
# CLI Entry
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    poll_oura()
