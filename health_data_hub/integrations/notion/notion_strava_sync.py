from __future__ import annotations

"""
Sync workout data from Postgres into a Notion database.

Sources:
- Postgres view: notion_workouts_view
Targets:
- Notion database: NOTION_WORKOUT_DB_ID
"""

from datetime import date
from notion_client import Client
from psycopg2.extras import RealDictCursor

import os

from health_data_hub.utils.db_connect import get_connection
from health_data_hub.config.settings import (
    NOTION_TOKEN,
    NOTION_WORKOUT_DB_ID,
)

if not NOTION_TOKEN or not NOTION_WORKOUT_DB_ID:
    raise RuntimeError("Missing Notion configuration in environment.")

# Set NOTION_DRY_RUN=1 in your env file to log without writing to Notion.
DRY_RUN = os.getenv("NOTION_DRY_RUN", "0") == "1"


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

def safe_round(value, digits: int = 0):
    if value is None:
        return None
    try:
        return round(float(value), digits)
    except Exception:
        return None


def seconds_to_minutes(seconds):
    if seconds is None:
        return None
    try:
        return round(seconds / 60)
    except Exception:
        return None


def determine_tag(row: dict) -> str:
    """
    Tag source device based on elevation.

    If elevation is zero, assume Peloton.
    If elevation is positive or missing, assume Garmin.
    """
    elevation = row.get("elevation_meters")

    if elevation is None:
        return "Garmin Edge 530"

    if elevation == 0:
        return "Peloton Bike"

    return "Garmin Edge 530"

# -------------------------------------------------------------------
# Database fetch helpers
# -------------------------------------------------------------------

def fetch_workouts_since(since_date: date):
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT *
                FROM notion_workouts_view
                WHERE workout_date >= %s
                ORDER BY workout_date ASC
                """,
                (since_date,),
            )
            return cur.fetchall()
    finally:
        conn.close()


def fetch_summary_row(workout_id: int):
    """
    Return a single summary row from notion_workouts_view for the given workout id.
    """
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT *
                FROM notion_workouts_view
                WHERE workout_id = %s
                """,
                (workout_id,),
            )
            return cur.fetchone()
    finally:
        conn.close()

# -------------------------------------------------------------------
# Notion property mapping
# -------------------------------------------------------------------

def build_properties(row: dict) -> dict:
    name = row.get("name") or "Untitled workout"
    tag_value = determine_tag(row)

    return {
        "Name": {"title": [{"text": {"content": name}}]},

        # Performance metrics
        "Avg Cadence": {"number": row.get("avg_cadence")},
        "Avg Heart Rate": {"number": row.get("avg_heart_rate")},
        "Avg Speed": {"number": safe_round(row.get("avg_speed_mph"), 1)},
        "Max Speed": {"number": safe_round(row.get("max_speed_mph"), 1)},
        "Avg Watts": {"number": row.get("avg_watts")},
        "Max Watts": {"number": row.get("max_watts")},
        "Normalized Power": {"number": row.get("normalized_power")},
        "TSS": {"number": safe_round(row.get("tss"), 0)},

        # Distance and elevation
        "Distance": {"number": row.get("distance_miles")},
        "Elevation": {"number": row.get("elevation_meters")},

        # Duration in minutes
        "Duration": {"number": seconds_to_minutes(row.get("duration_seconds"))},

        # Kilojoules
        "Kj": {"number": safe_round(row.get("kj"), 0)},

        # Date
        "Workout Date": {"date": {"start": str(row.get("workout_date"))}},

        # Tags
        "Tags": {"multi_select": [{"name": tag_value}]},
    }

# -------------------------------------------------------------------
# Notion upsert logic
# -------------------------------------------------------------------

def upsert_workout(notion: Client, database_id: str, row: dict):
    workout_id = row["workout_id"]
    name = row.get("name") or "Untitled workout"

    if DRY_RUN:
        print(f"[DRY RUN] Would sync workout {workout_id}: {name}")
        return

    # First, search for an existing page that has a matching Workout ID property
    search_results = notion.search(
        query=str(workout_id),
        filter={"value": "page", "property": "object"},
    )

    page_id = None
    for result in search_results.get("results", []):
        props = result.get("properties", {})
        workout_prop = props.get("Workout ID", {})
        if "number" in workout_prop and workout_prop["number"] == workout_id:
            page_id = result["id"]
            break

    props = build_properties(row)

    if page_id:
        notion.pages.update(page_id=page_id, properties=props)
        print(f"Updated workout {workout_id}: {name}")
    else:
        notion.pages.create(
            parent={"database_id": database_id},
            properties=props,
        )
        print(f"Created workout {workout_id}: {name}")

# -------------------------------------------------------------------
# Bulk sync by date
# -------------------------------------------------------------------

def sync_to_notion(since: date | None = None):
    if since is None:
        since = date.today()

    rows = fetch_workouts_since(since)
    print(f"Found {len(rows)} workouts on or after {since}.")

    if not rows:
        print("No workouts to sync.")
        return

    notion = Client(auth=NOTION_TOKEN)

    for row in rows:
        upsert_workout(notion, NOTION_WORKOUT_DB_ID, row)

    print("Sync complete.")

# -------------------------------------------------------------------
# Sync newest workout (legacy, still available)
# -------------------------------------------------------------------

def sync_single_newest():
    """
    Sync only the newest workout in notion_workouts_view.
    This remains for manual use, but the poller should call sync_specific_workout instead.
    """
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT *
                FROM notion_workouts_view
                ORDER BY workout_date DESC
                LIMIT 1
                """
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        print("[Notion] No workouts found to sync.")
        return

    notion = Client(auth=NOTION_TOKEN)
    upsert_workout(notion, NOTION_WORKOUT_DB_ID, row)
    print(f"[Notion] Synced newest workout: {row.get('name')}")

# -------------------------------------------------------------------
# Sync specific workout id (used by poll_strava)
# -------------------------------------------------------------------

def sync_specific_workout(workout_id: int):
    """
    Sync exactly one workout, identified by its workout_id.
    Intended for use by poll_strava after inserting and summarizing a new workout.
    """
    row = fetch_summary_row(workout_id)

    if not row:
        raise ValueError(f"No summary row found for workout_id {workout_id}")

    notion = Client(auth=NOTION_TOKEN)
    upsert_workout(notion, NOTION_WORKOUT_DB_ID, row)
    print(f"[Notion] Synced specific workout: {row.get('name')} (ID {workout_id})")

# -------------------------------------------------------------------
# Main entry for manual runs
# -------------------------------------------------------------------

if __name__ == "__main__":
    # Example manual sync starting at a given date
    sync_to_notion(date(2025, 11, 23))
