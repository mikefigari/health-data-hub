"""
Daily Oura poller.

Runs once per day, intended for morning.
Pulls last N days to handle late finalized sleep and readiness adjustments.

Sleep, readiness, and HR samples are sourced from the sleep endpoint payload.
Daily activity is sourced from the activity endpoint payload.

Safe to rerun due to ON CONFLICT upserts and unique constraints.
"""

from __future__ import annotations

from datetime import date, timedelta
import sys
import traceback
from typing import Iterable, Tuple

from health_data_hub.utils.db_connect import get_connection

from health_data_hub.integrations.oura.oura_api import fetch_sleep, fetch_activity

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


def _iso_range(start_d: date, end_d: date) -> Tuple[str, str]:
    """
    Returns ISO start and end date strings.
    Assumes the API accepts date strings.
    """
    return start_d.isoformat(), end_d.isoformat()


def _dates_back(days_back: int) -> Tuple[date, date]:
    """
    Inclusive range start, inclusive end.
    We pass these as ISO strings to the API.
    """
    today = date.today()
    start = today - timedelta(days=days_back)
    return start, today


def poll_oura(days_back_sleep: int = 3, days_back_activity: int = 1) -> int:
    """
    Returns process exit code.
    0 means success.
    Non zero means at least one step failed.
    """
    print("=== Oura Poller Started ===")

    sleep_start, sleep_end = _dates_back(days_back_sleep)
    activity_start, activity_end = _dates_back(days_back_activity)

    sleep_start_iso, sleep_end_iso = _iso_range(sleep_start, sleep_end)
    activity_start_iso, activity_end_iso = _iso_range(activity_start, activity_end)

    print(f"Sleep window: {sleep_start_iso} to {sleep_end_iso}")
    print(f"Activity window: {activity_start_iso} to {activity_end_iso}")

    conn = get_connection()
    exit_code = 0

    try:
        print("Fetching sleep payload")
        sleep_json = fetch_sleep(sleep_start_iso, sleep_end_iso)

        sleep_rows = extract_sleep_records(sleep_json)
        readiness_rows = extract_readiness_records(sleep_json)
        hr_rows = extract_hr_samples(sleep_json)

        print(f"Parsed sleep rows: {len(sleep_rows)}")
        print(f"Parsed readiness rows: {len(readiness_rows)}")
        print(f"Parsed hr sample rows: {len(hr_rows)}")

        inserted_sleep = insert_oura_sleep(conn, sleep_rows)
        inserted_readiness = insert_oura_readiness(conn, readiness_rows)
        inserted_hr = insert_oura_hr(conn, hr_rows)

        print(f"Inserted or updated sleep: {inserted_sleep}")
        print(f"Inserted or updated readiness: {inserted_readiness}")
        print(f"Inserted or updated hr samples: {inserted_hr}")

    except Exception as e:
        exit_code = 1
        print("ERROR during sleep or readiness or hr polling")
        print(str(e))
        traceback.print_exc()

    try:
        print("Fetching activity payload")
        activity_json = fetch_activity(activity_start_iso, activity_end_iso)
        activity_rows = extract_activity_records(activity_json)

        print(f"Parsed activity rows: {len(activity_rows)}")

        inserted_activity = insert_oura_activity(conn, activity_rows)
        print(f"Inserted or updated activity: {inserted_activity}")

    except Exception as e:
        exit_code = 1
        print("ERROR during activity polling")
        print(str(e))
        traceback.print_exc()

    finally:
        try:
            conn.close()
        except Exception:
            pass

    if exit_code == 0:
        print("=== Oura Poller Completed Successfully ===")
    else:
        print("=== Oura Poller Completed With Errors ===")

    return exit_code


if __name__ == "__main__":
    code = poll_oura(days_back_sleep=3, days_back_activity=1)
    sys.exit(code)
