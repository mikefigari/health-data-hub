from __future__ import annotations

"""
Sync workout data from Postgres into a Notion database.

Sources:
- Postgres view: notion_workouts_view
Targets:
- Notion database: NOTION_WORKOUT_DB_ID
"""

from datetime import date
from pathlib import Path

import os
import requests
from notion_client import Client
from psycopg2.extras import RealDictCursor

from health_data_hub.config.settings import (
    NOTION_TOKEN,
    NOTION_WORKOUT_DB_ID,
)
from health_data_hub.etl.transform.power_zone_graph import generate_power_zone_graph
from health_data_hub.utils.db_connect import get_connection

if not NOTION_TOKEN or not NOTION_WORKOUT_DB_ID:
    raise RuntimeError("Missing Notion configuration in environment.")

DRY_RUN = os.getenv("NOTION_DRY_RUN", "0") == "1"
NOTION_SDK_VERSION = "2022-06-28"
NOTION_FILE_UPLOAD_VERSION = "2026-03-11"
NOTION_API_BASE = "https://api.notion.com/v1"
CYCLING_SPORT_TYPES = {
    "ride",
    "virtualride",
    "ebikeride",
    "handcycleride",
    "gravelride",
}


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



def _is_cycling_workout(row: dict) -> bool:
    sport_type = (row.get("sport_type") or "").replace(" ", "").lower()
    return sport_type in CYCLING_SPORT_TYPES or sport_type.endswith("ride")



def _notion_headers(content_type: str = "application/json") -> dict:
    return {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": NOTION_FILE_UPLOAD_VERSION,
        "Content-Type": content_type,
    }



def _upload_file_to_notion(file_path: Path) -> str:
    create_resp = requests.post(
        f"{NOTION_API_BASE}/file_uploads",
        headers=_notion_headers(),
        json={},
        timeout=30,
    )
    create_resp.raise_for_status()
    upload = create_resp.json()
    upload_id = upload["id"]

    with file_path.open("rb") as fh:
        send_resp = requests.post(
            f"{NOTION_API_BASE}/file_uploads/{upload_id}/send",
            headers={
                "Authorization": f"Bearer {NOTION_TOKEN}",
                "Notion-Version": NOTION_FILE_UPLOAD_VERSION,
            },
            files={"file": (file_path.name, fh, "image/png")},
            timeout=120,
        )
    send_resp.raise_for_status()
    return upload_id



def _set_page_cover(page_id: str, file_upload_id: str):
    response = requests.patch(
        f"{NOTION_API_BASE}/pages/{page_id}",
        headers=_notion_headers(),
        json={
            "cover": {
                "type": "file_upload",
                "file_upload": {"id": file_upload_id},
            }
        },
        timeout=30,
    )
    response.raise_for_status()



def _sync_power_zone_cover(page_id: str, workout_id: int):
    graph = generate_power_zone_graph(workout_id)
    if graph is None:
        print(f"[Notion] No power-zone graph available for workout {workout_id}; skipping cover upload.")
        return

    file_upload_id = _upload_file_to_notion(Path(graph["output_path"]))
    _set_page_cover(page_id, file_upload_id)
    print(f"[Notion] Attached power-zone graph to workout {workout_id}")


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
        "Workout ID": {"number": row.get("workout_id")},
        "Avg Cadence": {"number": row.get("avg_cadence")},
        "Avg Heart Rate": {"number": row.get("avg_heart_rate")},
        "Avg Speed": {"number": safe_round(row.get("avg_speed_mph"), 1)},
        "Max Speed": {"number": safe_round(row.get("max_speed_mph"), 1)},
        "Avg Watts": {"number": row.get("avg_watts")},
        "Max Watts": {"number": row.get("max_watts")},
        "Normalized Power": {"number": row.get("normalized_power")},
        "TSS": {"number": safe_round(row.get("tss"), 0)},
        "Distance": {"number": row.get("distance_miles")},
        "Elevation": {"number": row.get("elevation_meters")},
        "Duration": {"number": seconds_to_minutes(row.get("duration_seconds"))},
        "Kj": {"number": safe_round(row.get("kj"), 0)},
        "Workout Date": {"date": {"start": str(row.get("workout_date"))}},
        "Tags": {"multi_select": [{"name": tag_value}]},
    }


# -------------------------------------------------------------------
# Notion upsert logic
# -------------------------------------------------------------------

def _find_page_id(notion: Client, database_id: str, workout_id: int):
    """
    Look up an existing Notion page by Workout ID property using a
    database filter. More reliable than notion.search() which does
    full-text matching and can return wrong results.
    """
    response = notion.request(
        path=f"databases/{database_id}/query",
        method="POST",
        body={
            "filter": {
                "property": "Workout ID",
                "number": {"equals": workout_id},
            }
        },
    )
    results = response.get("results", [])
    return results[0]["id"] if results else None



def upsert_workout(notion: Client, database_id: str, row: dict):
    workout_id = row["workout_id"]
    name = row.get("name") or "Untitled workout"

    if DRY_RUN:
        print(f"[DRY RUN] Would sync workout {workout_id}: {name}")
        return None

    page_id = _find_page_id(notion, database_id, workout_id)
    props = build_properties(row)

    if page_id:
        notion.pages.update(page_id=page_id, properties=props)
        print(f"Updated workout {workout_id}: {name}")
    else:
        created = notion.pages.create(
            parent={"database_id": database_id},
            properties=props,
        )
        page_id = created["id"]
        print(f"Created workout {workout_id}: {name}")

    if page_id and _is_cycling_workout(row):
        try:
            _sync_power_zone_cover(page_id, workout_id)
        except Exception as exc:
            print(f"[Notion] Power-zone graph upload failed for workout {workout_id}: {exc}")

    return page_id


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

    notion = Client(auth=NOTION_TOKEN, notion_version=NOTION_SDK_VERSION)

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

    notion = Client(auth=NOTION_TOKEN, notion_version=NOTION_SDK_VERSION)
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

    notion = Client(auth=NOTION_TOKEN, notion_version=NOTION_SDK_VERSION)
    upsert_workout(notion, NOTION_WORKOUT_DB_ID, row)
    print(f"[Notion] Synced specific workout: {row.get('name')} (ID {workout_id})")


# -------------------------------------------------------------------
# Main entry for manual runs
# -------------------------------------------------------------------

if __name__ == "__main__":
    sync_to_notion(date(2025, 11, 23))
