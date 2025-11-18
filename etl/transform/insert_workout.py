import os
from datetime import datetime, timedelta

import psycopg2
from dotenv import load_dotenv

# Load env vars from config/dev.env
load_dotenv("config/dev.env")

DB_HOST = os.getenv("DB_HOST")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_PORT = os.getenv("DB_PORT", "5432")


def get_db_connection():
    return psycopg2.connect(
        host=DB_HOST,
        dbname=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD,
        port=DB_PORT,
    )


def _parse_strava_time(iso_str: str):
    """
    Strava gives times like '2025-11-17T18:05:32Z'.
    Convert to a timezone-aware datetime in UTC.
    """
    if not iso_str:
        return None
    # fromisoformat does not understand the 'Z' suffix, so swap it for +00:00
    return datetime.fromisoformat(iso_str.replace("Z", "+00:00"))


def insert_workout_metadata(activity: dict) -> int:
    """
    Insert a Strava activity into workouts_raw and return the new id.
    Matches the CURRENT workouts_raw schema.
    """

    source = "strava"
    external_id = str(activity.get("id"))

    start_time_iso = activity.get("start_date")          # e.g. '2025-11-17T18:05:32Z'
    elapsed = activity.get("elapsed_time") or 0          # seconds

    start_dt = _parse_strava_time(start_time_iso)
    end_dt = start_dt + timedelta(seconds=elapsed) if start_dt else None

    sport_type = activity.get("sport_type") or activity.get("type")
    raw_file_format = None
    raw_file_path = None

    conn = get_db_connection()
    cur = conn.cursor()

    sql = """
        INSERT INTO workouts_raw (
            source,
            external_id,
            start_time,
            end_time,
            sport_type,
            raw_file_format,
            raw_file_path
        )
        VALUES (
            %s, %s, %s, %s, %s, %s, %s
        )
        RETURNING id;
    """

    values = (
        source,
        external_id,
        start_dt,
        end_dt,
        sport_type,
        raw_file_format,
        raw_file_path,
    )

    cur.execute(sql, values)
    new_id = cur.fetchone()[0]

    conn.commit()
    cur.close()
    conn.close()

    return new_id
