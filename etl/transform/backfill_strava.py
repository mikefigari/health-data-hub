from datetime import timedelta

from etl.extract.strava_api import (
    get_all_strava_activities,
    get_activity_streams,
)
from .insert_workout import get_db_connection, insert_workout_metadata


def backfill_metadata():
    """
    Pull all Strava activities and insert any that are missing in workouts_raw.
    """
    activities = get_all_strava_activities()

    conn = get_db_connection()
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
            print(
                f"[{idx}/{total}] Activity {activity_id} already in workouts_raw, skipping."
            )
            continue

        workout_id = insert_workout_metadata(activity)
        inserted += 1
        print(
            f"[{idx}/{total}] Inserted activity {activity_id} as workout_id {workout_id}"
        )

    print(f"Metadata backfill complete. Inserted {inserted} new workouts.")


def _stream_data(streams, key):
    """
    Normalize Strava stream payload to a list. Missing keys return an empty list.
    """
    if not streams:
        return []
    stream_obj = streams.get(key)
    if isinstance(stream_obj, dict):
        return stream_obj.get("data") or []
    return stream_obj or []


def insert_stream_samples(workout_id, streams):
    """
    Insert aligned second-level stream data for a workout.
    """
    conn = get_db_connection()
    cur = conn.cursor()

    try:
        cur.execute(
            "SELECT 1 FROM workout_samples WHERE workout_id = %s LIMIT 1;",
            (workout_id,),
        )
        if cur.fetchone():
            print(f"Samples already exist for workout_id {workout_id}, skipping.")
            return

        cur.execute(
            "SELECT start_time FROM workouts_raw WHERE id = %s;",
            (workout_id,),
        )
        row = cur.fetchone()
        if not row or not row[0]:
            print(f"No start_time found for workout_id {workout_id}, skipping.")
            return

        start_time = row[0]

        time_data = _stream_data(streams, "time")
        if not time_data:
            print(f"No time stream for workout_id {workout_id}, skipping.")
            return

        hr_data = _stream_data(streams, "heartrate")
        cadence_data = _stream_data(streams, "cadence")
        watts_data = _stream_data(streams, "watts")
        speed_data = _stream_data(streams, "velocity_smooth")

        rows = []
        for idx, seconds_from_start in enumerate(time_data):
            ts = start_time + timedelta(seconds=seconds_from_start)
            heartrate = hr_data[idx] if idx < len(hr_data) else None
            cadence = cadence_data[idx] if idx < len(cadence_data) else None
            watts = watts_data[idx] if idx < len(watts_data) else None
            speed = speed_data[idx] if idx < len(speed_data) else None
            rows.append((workout_id, ts, heartrate, cadence, watts, speed))

        insert_sql = """
            INSERT INTO workout_samples (
                workout_id,
                ts,
                heartrate,
                cadence,
                watts,
                speed
            )
            VALUES (%s, %s, %s, %s, %s, %s);
        """

        cur.executemany(insert_sql, rows)
        conn.commit()
        print(f"Inserted {len(rows)} samples for workout_id {workout_id}.")

    finally:
        cur.close()
        conn.close()


def _samples_exist(workout_id):
    """
    Return True if at least one sample row already exists.
    """
    conn = get_db_connection()
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


def backfill_streams():
    """
    Fetch stream data for workouts missing samples.
    """
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, external_id
        FROM workouts_raw
        WHERE source = %s
        ORDER BY start_time;
        """,
        ("strava",),
    )
    workouts = cur.fetchall()
    cur.close()
    conn.close()

    total = len(workouts)
    print(f"Found {total} Strava workouts in workouts_raw.")

    for idx, (workout_id, external_id) in enumerate(workouts, start=1):
        if _samples_exist(workout_id):
            print(
                f"[{idx}/{total}] Workout {workout_id} already has samples, skipping stream fetch."
            )
            continue

        try:
            streams = get_activity_streams(external_id)
        except Exception as e:
            print(
                f"[{idx}/{total}] Error fetching streams for workout_id {workout_id} "
                f"(activity {external_id}): {e}"
            )
            continue

        if not streams:
            print(
                f"[{idx}/{total}] No streams for workout_id {workout_id} "
                f"(activity {external_id}), skipping."
            )
            continue

        try:
            insert_stream_samples(workout_id, streams)
            print(f"[{idx}/{total}] Processed streams for workout_id {workout_id}.")
        except Exception as e:
            print(
                f"[{idx}/{total}] Error inserting samples for workout_id {workout_id}: {e}"
            )


def backfill_all():
    """
    Run both metadata and stream backfills.
    """
    backfill_metadata()
    backfill_streams()
