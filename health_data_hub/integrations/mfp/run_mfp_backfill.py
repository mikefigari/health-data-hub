"""
MyFitnessPal nutrition backfill — pulls 90 days of history.

Run once to populate nutrition_daily from scratch.
Uses a 1-second sleep between days to avoid rate limiting.

Usage:
    python -m health_data_hub.integrations.mfp.run_mfp_backfill
"""

from __future__ import annotations

import json
import sys
import time
from datetime import date, timedelta

import requests

from health_data_hub.integrations.mfp.mfp_auth import get_client
from health_data_hub.etl.extract.mfp_extract import extract_daily_nutrition
from health_data_hub.etl.load.insert_nutrition_daily import insert_nutrition_daily
from health_data_hub.utils.db_connect import get_connection

BACKFILL_DAYS = 90
SLEEP_BETWEEN_DAYS = 1.0  # seconds — polite rate limiting


def run_backfill() -> None:
    print("Authenticating with MyFitnessPal...")
    client = get_client()

    conn = get_connection()
    today = date.today()
    total_upserted = 0
    errors = 0

    for i in range(BACKFILL_DAYS):
        target_date = today - timedelta(days=i + 1)
        print(f"\n[MFP Backfill] {target_date}", end=" ", flush=True)

        try:
            day_obj = client.get_date(target_date.year, target_date.month, target_date.day)
            row = extract_daily_nutrition(day_obj, target_date)

            if row is None:
                print("(no data logged)")
            else:
                upserted = insert_nutrition_daily(conn, [row])
                total_upserted += upserted
                print(f"✓ {row.get('calories')} kcal, {row.get('protein_g')}g protein")

        except (json.JSONDecodeError, KeyError) as e:
            print(f"✗ parse error: {e}")
            errors += 1
            conn.rollback()
        except requests.HTTPError as e:
            print(f"✗ HTTP error: {e}")
            errors += 1
            conn.rollback()
        except Exception as e:
            print(f"✗ {type(e).__name__}: {e}")
            errors += 1
            conn.rollback()

        time.sleep(SLEEP_BETWEEN_DAYS)

    conn.close()
    print(f"\nMFP backfill complete. Upserted: {total_upserted}, Errors: {errors}")


if __name__ == "__main__":
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()
    run_backfill()
