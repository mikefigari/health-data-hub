import sys
from datetime import datetime, timedelta
from pathlib import Path

# Ensure absolute package imports work from any cwd
PROJECT_PARENT = Path(__file__).resolve().parents[3]
if str(PROJECT_PARENT) not in sys.path:
    sys.path.insert(0, str(PROJECT_PARENT))

from health_data_hub.utils.db_connect import get_connection  # noqa: E402


def _parse_strava_time(iso_str: str):
    """
    Strava gives times like '2025-11-17T18:05:32Z'.
    Convert to a timezone-aware datetime in UTC.
    """
    if not iso_str:
        return None
    # Ensure we handle the trailing 'Z' as UTC
    return datetime.fromisoformat(iso_str.replace("Z", "+00:00"))


def insert_workout_metadata(activity: dict) -> int:
    """
    Insert a Strava activity into workouts_raw and return the new id.

    - Uses the workouts_raw schema in db/schema.sql
    - Stores rich Strava metadata (distance, power, HR, etc.)
    - Is idempotent via ON CONFLICT (external_id) DO UPDATE
    """

    # Basic identifiers
    source = "strava"
    external_id = str(activity.get("id"))

    # Times: use UTC start_date and compute end_time from elapsed_s
    start_time_iso = activity.get("start_date") or activity.get("start_date_local")
    elapsed_s = activity.get("elapsed_time") or 0

    start_dt = _parse_strava_time(start_time_iso)
    end_dt = start_dt + timedelta(seconds=elapsed_s) if start_dt else None

    # Core metadata
    sport_type = activity.get("sport_type") or activity.get("type")
    title = activity.get("name")

    distance_m = activity.get("distance")
    moving_s = activity.get("moving_time")
    avg_speed = activity.get("average_speed")
    max_speed = activity.get("max_speed")

    avg_cadence = activity.get("average_cadence")
    avg_hr = activity.get("average_heartrate")
    max_hr = activity.get("max_heartrate")

    avg_watts = activity.get("average_watts")
    max_watts = activity.get("max_watts")
    weighted_average_watts = activity.get("weighted_average_watts")
    kj = activity.get("kilojoules")
    device_watts = activity.get("device_watts")

    total_elevation_gain = activity.get("total_elevation_gain")
    has_heartrate = activity.get("has_heartrate")
    timezone = activity.get("timezone")

    # Raw file info (not used yet, but reserved for future imports)
    raw_file_format = None
    raw_file_path = None

    conn = get_connection()
    cur = conn.cursor()

    sql = """
        INSERT INTO workouts_raw (
            source,
            external_id,
            start_time,
            end_time,
            sport_type,
            distance_m,
            moving_s,
            elapsed_s,
            avg_speed,
            max_speed,
            avg_cadence,
            avg_hr,
            max_hr,
            avg_watts,
            max_watts,
            weighted_average_watts,
            kj,
            device_watts,
            title,
            total_elevation_gain,
            has_heartrate,
            timezone,
            raw_file_format,
            raw_file_path
        )
        VALUES (
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s,
            %s, %s, %s, %s
        )
        ON CONFLICT (external_id) DO UPDATE SET
            source                 = EXCLUDED.source,
            start_time             = EXCLUDED.start_time,
            end_time               = EXCLUDED.end_time,
            sport_type             = EXCLUDED.sport_type,
            distance_m             = EXCLUDED.distance_m,
            moving_s               = EXCLUDED.moving_s,
            elapsed_s              = EXCLUDED.elapsed_s,
            avg_speed              = EXCLUDED.avg_speed,
            max_speed              = EXCLUDED.max_speed,
            avg_cadence            = EXCLUDED.avg_cadence,
            avg_hr                 = EXCLUDED.avg_hr,
            max_hr                 = EXCLUDED.max_hr,
            avg_watts              = EXCLUDED.avg_watts,
            max_watts              = EXCLUDED.max_watts,
            weighted_average_watts = EXCLUDED.weighted_average_watts,
            kj                     = EXCLUDED.kj,
            device_watts           = EXCLUDED.device_watts,
            title                  = EXCLUDED.title,
            total_elevation_gain   = EXCLUDED.total_elevation_gain,
            has_heartrate          = EXCLUDED.has_heartrate,
            timezone               = EXCLUDED.timezone,
            raw_file_format        = EXCLUDED.raw_file_format,
            raw_file_path          = EXCLUDED.raw_file_path,
            inserted_at            = NOW()
        RETURNING id;
    """

    values = (
        source,
        external_id,
        start_dt,
        end_dt,
        sport_type,
        distance_m,
        moving_s,
        elapsed_s,
        avg_speed,
        max_speed,
        avg_cadence,
        avg_hr,
        max_hr,
        avg_watts,
        max_watts,
        weighted_average_watts,
        kj,
        device_watts,
        title,
        total_elevation_gain,
        has_heartrate,
        timezone,
        raw_file_format,
        raw_file_path,
    )

    cur.execute(sql, values)
    new_id = cur.fetchone()[0]

    conn.commit()
    cur.close()
    conn.close()

    return new_id
