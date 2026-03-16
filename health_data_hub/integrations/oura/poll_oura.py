"""
Daily Oura poller.

Runs once per day, intended for morning.
Pulls last N days to handle late finalized sleep and readiness adjustments.

Sleep, readiness, and HR samples are sourced from the sleep endpoint payload.
Daily activity is sourced from the activity endpoint payload.

Safe to rerun due to ON CONFLICT upserts and unique constraints.
"""

from __future__ import annotations

import logging
import sys
import traceback
from datetime import date, timedelta
from typing import Tuple

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

logger = logging.getLogger(__name__)


def _dates_back(days_back: int) -> Tuple[str, str]:
    today = date.today()
    start = today - timedelta(days=days_back)
    return start.isoformat(), today.isoformat()


def poll_oura(days_back_sleep: int = 3, days_back_activity: int = 1) -> int:
    """
    Returns process exit code: 0 = success, non-zero = at least one step failed.
    """
    logger.info("=== Oura Poller Started ===")

    sleep_start, sleep_end = _dates_back(days_back_sleep)
    activity_start, activity_end = _dates_back(days_back_activity)

    logger.info("Sleep window: %s to %s", sleep_start, sleep_end)
    logger.info("Activity window: %s to %s", activity_start, activity_end)

    conn = get_connection()
    exit_code = 0

    try:
        logger.info("Fetching sleep payload...")
        sleep_json = fetch_sleep(sleep_start, sleep_end)

        sleep_rows = extract_sleep_records(sleep_json)
        readiness_rows = extract_readiness_records(sleep_json)
        hr_rows = extract_hr_samples(sleep_json)

        logger.info("Parsed %d sleep rows", len(sleep_rows))
        logger.info("Parsed %d readiness rows", len(readiness_rows))
        logger.info("Parsed %d HR sample rows", len(hr_rows))

        inserted_sleep = insert_oura_sleep(conn, sleep_rows)
        inserted_readiness = insert_oura_readiness(conn, readiness_rows)
        inserted_hr = insert_oura_hr(conn, hr_rows)

        logger.info("Upserted sleep: %d", inserted_sleep)
        logger.info("Upserted readiness: %d", inserted_readiness)
        logger.info("Upserted HR samples: %d", inserted_hr)

    except Exception as e:
        exit_code = 1
        logger.error("Error during sleep/readiness/HR polling: %s", e, exc_info=True)

    try:
        logger.info("Fetching activity payload...")
        activity_json = fetch_activity(activity_start, activity_end)
        activity_rows = extract_activity_records(activity_json)

        logger.info("Parsed %d activity rows", len(activity_rows))

        inserted_activity = insert_oura_activity(conn, activity_rows)
        logger.info("Upserted activity: %d", inserted_activity)

    except Exception as e:
        exit_code = 1
        logger.error("Error during activity polling: %s", e, exc_info=True)

    finally:
        try:
            conn.close()
        except Exception:
            pass

    if exit_code == 0:
        logger.info("=== Oura Poller Completed Successfully ===")
    else:
        logger.warning("=== Oura Poller Completed With Errors ===")

    return exit_code


if __name__ == "__main__":
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()
    code = poll_oura(days_back_sleep=3, days_back_activity=1)
    sys.exit(code)
