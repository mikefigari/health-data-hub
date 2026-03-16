"""
Notion Daily Physical State poller.

Queries the Notion Daily Physical State database for pages edited in the
last N days, extracts records, and upserts into daily_physical_state.

Safe to rerun due to ON CONFLICT upserts keyed on day.
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timedelta, timezone

from notion_client import Client

from health_data_hub.config.settings import NOTION_TOKEN, NOTION_DAILY_STATE_DB_ID
from health_data_hub.utils.db_connect import get_connection
from health_data_hub.etl.extract.notion_daily_state_extract import extract_daily_state_records
from health_data_hub.etl.load.insert_daily_physical_state import insert_daily_physical_state

logger = logging.getLogger(__name__)


def poll_notion_daily_state(days_back: int = 30) -> int:
    """
    Returns process exit code: 0 = success, 1 = error.
    """
    logger.info("=== Notion Daily State Poller Started ===")

    if not NOTION_TOKEN or not NOTION_DAILY_STATE_DB_ID:
        logger.error("Missing NOTION_TOKEN or NOTION_DAILY_STATE_DB_ID in environment.")
        return 1

    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    logger.info("Querying pages last edited on or after %s", cutoff.isoformat())

    try:
        notion = Client(auth=NOTION_TOKEN, notion_version="2022-06-28")

        filter_kwargs = {
            "filter": {
                "timestamp": "last_edited_time",
                "last_edited_time": {"on_or_after": cutoff.isoformat()},
            }
        }

        pages = []
        response = notion.request(
            path=f"databases/{NOTION_DAILY_STATE_DB_ID}/query",
            method="POST",
            body=filter_kwargs,
        )
        pages.extend(response.get("results", []))

        while response.get("has_more"):
            response = notion.request(
                path=f"databases/{NOTION_DAILY_STATE_DB_ID}/query",
                method="POST",
                body={**filter_kwargs, "start_cursor": response["next_cursor"]},
            )
            pages.extend(response.get("results", []))

        logger.info("Retrieved %d pages from Notion", len(pages))

        rows = extract_daily_state_records(pages)
        logger.info("Extracted %d rows", len(rows))

        conn = get_connection()
        try:
            upserted = insert_daily_physical_state(conn, rows)
            logger.info("Upserted %d rows into daily_physical_state", upserted)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    except Exception as e:
        logger.error("Notion daily state poll failed: %s", e, exc_info=True)
        return 1

    logger.info("=== Notion Daily State Poller Completed Successfully ===")
    return 0


if __name__ == "__main__":
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()
    code = poll_notion_daily_state(days_back=30)
    sys.exit(code)
