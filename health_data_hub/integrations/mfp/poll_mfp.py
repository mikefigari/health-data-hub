"""
MyFitnessPal daily nutrition poller.

Pulls last N days of nutrition data from MFP and upserts into nutrition_daily.
Safe to rerun due to ON CONFLICT upserts keyed on day.

Error handling:
  - Per-day fetch errors (parser failure, 403, network) are logged and skipped.
  - Auth failure is fatal (fail-fast before opening DB connection).
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import date, timedelta

import requests

from health_data_hub.integrations.mfp.mfp_auth import get_client
from health_data_hub.etl.extract.mfp_extract import extract_daily_nutrition
from health_data_hub.etl.load.insert_nutrition_daily import insert_nutrition_daily
from health_data_hub.utils.db_connect import get_connection

logger = logging.getLogger(__name__)


def poll_mfp(days_back: int = 7) -> int:
    """
    Pull MFP nutrition data for the last N days.
    Returns 0 on success, 1 on error.
    """
    logger.info("=== MFP Nutrition Poller Started ===")

    # Auth failure is fatal — no point opening DB if we can't fetch
    try:
        client = get_client()
    except RuntimeError as e:
        logger.error("MFP auth failed: %s", e)
        return 1

    today = date.today()
    dates = [today - timedelta(days=i) for i in range(days_back)]
    logger.info("Fetching %d days: %s to %s", days_back, dates[-1], dates[0])

    rows = []
    for target_date in dates:
        try:
            day_obj = client.get_date(target_date.year, target_date.month, target_date.day)
            row = extract_daily_nutrition(day_obj, target_date)
            if row is not None:
                rows.append(row)
                logger.debug("Fetched %s: %s kcal", target_date, row.get("calories"))
            else:
                logger.debug("No data logged for %s — skipping", target_date)
        except (json.JSONDecodeError, KeyError) as e:
            logger.warning("Parse error for %s: %s — skipping", target_date, e)
        except requests.HTTPError as e:
            logger.warning("HTTP error for %s: %s — skipping", target_date, e)
        except Exception as e:
            # Catch lxml ParserError and any other unexpected errors
            logger.warning("Unexpected error for %s (%s): %s — skipping", target_date, type(e).__name__, e)

    logger.info("Extracted %d rows with logged data", len(rows))

    if not rows:
        logger.info("No rows to upsert.")
        logger.info("=== MFP Nutrition Poller Completed (no data) ===")
        return 0

    conn = get_connection()
    try:
        upserted = insert_nutrition_daily(conn, rows)
        logger.info("Upserted %d rows into nutrition_daily", upserted)
    except Exception as e:
        logger.error("DB insert failed: %s", e, exc_info=True)
        return 1
    finally:
        try:
            conn.close()
        except Exception:
            pass

    logger.info("=== MFP Nutrition Poller Completed Successfully ===")
    return 0


if __name__ == "__main__":
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()
    code = poll_mfp(days_back=7)
    sys.exit(code)
