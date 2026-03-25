"""
Apple Health nutrition poller.

Polls GET {HEALTH_WORKER_URL}/latest every hour via scheduler_all.py.
If the Worker returns a date not already in nutrition_daily, upserts
the row and logs the result.

Exit behaviour (when run directly):
    0 — success (upserted, skipped, or no data yet)
    1 — request or DB error

Usage (manual):
    python -m health_data_hub.integrations.apple_health.nutrition_poller
"""

from __future__ import annotations

import logging
import sys
from datetime import date, datetime, timezone

import requests

from health_data_hub.config.settings import HEALTH_TOKEN, HEALTH_WORKER_URL
from health_data_hub.etl.load.insert_nutrition_daily import insert_nutrition_daily
from health_data_hub.utils.db_connect import get_connection

logger = logging.getLogger(__name__)

_CHECK_SQL = "SELECT 1 FROM nutrition_daily WHERE day = %s"


def _date_in_db(conn, date_str: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(_CHECK_SQL, (date_str,))
        return cur.fetchone() is not None


def poll_once() -> int:
    """
    Fetch latest nutrition record from the Worker and upsert if new.
    Returns 0 on success, 1 on request/DB error.
    """
    url = f"{HEALTH_WORKER_URL.rstrip('/')}/latest"
    headers = {"X-Health-Token": HEALTH_TOKEN}

    try:
        resp = requests.get(url, headers=headers, timeout=15)
    except requests.RequestException as e:
        logger.error("Request to Worker failed: %s", e)
        return 1

    if resp.status_code == 404:
        logger.info("No nutrition data available yet")
        return 0

    if resp.status_code != 200:
        logger.error("Worker returned %d: %s", resp.status_code, resp.text[:200])
        return 1

    data = resp.json()
    date_str: str = data.get("date", "")
    if not date_str:
        logger.error("Worker response missing 'date' field: %s", data)
        return 1

    conn = get_connection()
    try:
        if _date_in_db(conn, date_str):
            logger.info("Nutrition already present for %s — skipping", date_str)
            return 0

        now_utc = datetime.now(timezone.utc)
        row = {
            "day":             date.fromisoformat(date_str),
            "calories":        data.get("calories"),
            "protein_g":       data.get("protein_g"),
            "carbs_g":         data.get("carbs_g"),
            "fat_g":           data.get("fat_g"),
            "fiber_g":         data.get("fiber_g"),
            "sugar_g":         None,
            "sodium_mg":       None,
            "goal_calories":   None,
            "goal_protein_g":  None,
            "goal_carbs_g":    None,
            "goal_fat_g":      None,
            "meals_json":      None,
            "source":          "apple_health",
            "logged_complete": None,
            "weight_kg":       None,
            "created_at":      now_utc,
            "updated_at":      now_utc,
        }
        insert_nutrition_daily(conn, [row])
        logger.info(
            "Nutrition upserted for %s: %s kcal",
            date_str,
            data.get("calories"),
        )
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()
    sys.exit(poll_once())
