"""
Historical backfill for Strava workouts.

Fetches all activities since 2022 and populates workouts_raw and
workout_samples for any that are missing. Safe to re-run — skips
workouts and samples that already exist.
"""

from datetime import datetime, timezone

from health_data_hub.utils.db_connect import get_connection
from health_data_hub.etl.extract.strava_refresh import refresh_access_token
from health_data_hub.etl.extract.strava_api import (
    get_all_strava_activities,
    get_activity_streams,
)
from health_data_hub.etl.load.insert_workout import insert_workout_metadata

AFTER_2022 = int(datetime(2022, 1, 1, tzinfo=timezone.utc).timestamp())


def backfill_metadata(access_token: str):
    """
    Pull all Strava activities and insert any missing from workouts_raw.
    """
    activities = get_all_strava_activities(access_token, after=AFTER_2022)

    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT external_id FROM workouts_raw WHERE source = %s;",
        ("strava",),
    )
    existing_ids = {row[0] for row in cur.fetchall()}
    cur.close()
    conn.close()

    total = len(activities)
    inserted = 0

    for idx, activity in enumerate(activities, start=1):
        activity_id = str(activity.get("id"))
        if activity_id in existing_ids:
            print(f"[{idx}/{total}] Activity {activity_id} already exists, skipping.")
            continue

        workout_id = insert_workout_metadata(activity)
        inserted += 1
        print(f"[{idx}/{total}] Inserted activity {activity_id} as workout_id {workout_id}")

    print(f"Metadata backfill complete. Inserted {inserted} new workouts.")


def _samples_exist(workout_id: int) -> bool:
    """Return True if at least one sample row already exists for this workout."""
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT 1 FROM workout_samples WHERE workout_id = %s LIMIT 1;",
            (workout_id,),
        )
        return cur.fetchone() is not None
    finally:
        cur.close()
        conn.close()


def insert_stream_samples(workout_id: int, streams: dict):
    """
    Insert second-level stream data for a workout.
    Matches the workout_samples schema: ts_seconds, heartrate, cadence,
    watts, velocity_mps.
    """
    if not streams:
        return

    time_data = (streams.get("time") or {}).get("data") or []
    if not time_data:
        print(f"No time stream for workout_id {workout_id}, skipping.")
        return

    hr_data      = (streams.get("heartrate")       or {}).get("data") or []
    cadence_data = (streams.get("cadence")         or {}).get("data") or []
    watts_data   = (streams.get("watts")           or {}).get("data") or []
    vel_data     = (streams.get("velocity_smooth") or {}).get("data") or []

    rows = []
    for idx, ts_seconds in enumerate(time_data):
        rows.append((
            workout_id,
            ts_seconds,
            hr_data[idx]      if idx < len(hr_data)      else None,
            cadence_data[idx] if idx < len(cadence_data) else None,
            watts_data[idx]   if idx < len(watts_data)   else None,
            vel_data[idx]     if idx < len(vel_data)     else None,
        ))

    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.executemany(
            """
            INSERT INTO workout_samples (
                workout_id, ts_seconds, heartrate, cadence, watts, velocity_mps
            ) VALUES (%s, %s, %s, %s, %s, %s)
            """,
            rows,
        )
        conn.commit()
        print(f"Inserted {len(rows)} samples for workout_id {workout_id}.")
    finally:
        cur.close()
        conn.close()


def backfill_streams(access_token: str):
    """
    Fetch stream data for any workouts that are missing samples.
    """
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, external_id FROM workouts_raw WHERE source = %s ORDER BY start_time;",
        ("strava",),
    )
    workouts = cur.fetchall()
    cur.close()
    conn.close()

    total = len(workouts)
    print(f"Found {total} Strava workouts to check for streams.")

    for idx, (workout_id, external_id) in enumerate(workouts, start=1):
        if _samples_exist(workout_id):
            print(f"[{idx}/{total}] Workout {workout_id} already has samples, skipping.")
            continue

        try:
            streams = get_activity_streams(access_token, int(external_id))
        except Exception as e:
            print(f"[{idx}/{total}] Stream fetch failed for workout {workout_id}: {e}")
            continue

        try:
            insert_stream_samples(workout_id, streams)
        except Exception as e:
            print(f"[{idx}/{total}] Sample insert failed for workout {workout_id}: {e}")


def backfill_all():
    """
    Run metadata and stream backfills. Refreshes the Strava token once
    and reuses it for all API calls.
    """
    print("Refreshing Strava token...")
    access_token = refresh_access_token()

    print("Backfilling workout metadata...")
    backfill_metadata(access_token)

    print("Backfilling workout stream samples...")
    backfill_streams(access_token)

    print("Backfill complete.")
