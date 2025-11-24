from datetime import date
from pathlib import Path
import os

from notion_client import Client
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

from utils.db_connect import get_connection


# -------------------------------------------------------------------
# Config
# -------------------------------------------------------------------

DRY_RUN = False  # True = print only, False = write to Notion

ENV_PATH = Path(__file__).resolve().parents[2] / "config" / "dev.env"
load_dotenv(ENV_PATH)

NOTION_TOKEN = os.getenv("NOTION_TOKEN")
NOTION_WORKOUT_DB_ID = os.getenv("NOTION_WORKOUT_DB_ID")

if NOTION_TOKEN is None or NOTION_WORKOUT_DB_ID is None:
    raise RuntimeError("NOTION_TOKEN or NOTION_WORKOUT_DB_ID not set in dev.env")


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

def safe_round(value, digits=0):
    if value is None:
        return None
    try:
        return round(float(value), digits)
    except:
        return None


def seconds_to_minutes(seconds):
    if seconds is None:
        return None
    try:
        return round(seconds / 60)
    except:
        return None


def determine_tag(row):
    """
    Peloton vs Outdoor based solely on elevation gain.
    Peloton → Elevation == 0
    Outdoor → Elevation > 0
    """
    elevation = row.get("elevation_meters")

    if elevation is None:
        return "Garmin Edge 530"

    if elevation == 0:
        return "Peloton Bike"
    else:
        return "Garmin Edge 530"


# -------------------------------------------------------------------
# Database fetch
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

        # Distance + Elevation
        "Distance": {"number": row.get("distance_miles")},
        "Elevation": {"number": row.get("elevation_meters")},

        # Duration (minutes)
        "Duration": {"number": seconds_to_minutes(row.get("duration_seconds"))},

        # KJ
        "Kj": {"number": safe_round(row.get("kj"), 0)},

        # Date
        "Workout Date": {"date": {"start": str(row.get("workout_date"))}},

        # Tags
        "Tags": {"multi_select": [{"name": tag_value}]},
    }


# -------------------------------------------------------------------
# Notion Upsert Logic
# -------------------------------------------------------------------

def upsert_workout(notion: Client, database_id: str, row: dict):
    workout_id = row["workout_id"]
    name = row.get("name") or "Untitled workout"

    if DRY_RUN:
        print(f"[DRY RUN] Would sync workout {workout_id}: {name}")
        return

    # Look for existing page with matching Workout ID
    search_results = notion.search(
        query=str(workout_id),
        filter={"value": "page", "property": "object"}
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
# Main Sync
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
# Polling for newest workout only
# -------------------------------------------------------------------

def sync_single_newest():
    """
    Sync ONLY the newest workout in notion_workouts_view.
    This is called right after new Strava ingestion.
    """
    conn = get_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute(
        """
        SELECT *
        FROM notion_workouts_view
        ORDER BY workout_date DESC
        LIMIT 1
        """
    )
    row = cur.fetchone()
    cur.close()
    conn.close()

    if row:
        notion = Client(auth=NOTION_TOKEN)
        upsert_workout(notion, NOTION_WORKOUT_DB_ID, row)
        print(f"[Notion] Synced newest workout: {row['name']}")


# -------------------------------------------------------------------
# Run single test sync
# -------------------------------------------------------------------

if __name__ == "__main__":
    sync_to_notion(date(2025, 11, 20))
