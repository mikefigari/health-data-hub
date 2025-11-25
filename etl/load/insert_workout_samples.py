# health_data_hub/etl/load/insert_workout_samples.py

from __future__ import annotations
from typing import Optional, Dict

from health_data_hub.utils.db_connect import get_connection


def insert_workout_samples(workout_id: int, streams: Optional[Dict]):
    """
    Insert second-by-second samples into workout_samples.

    Table columns we actually use:
      - workout_id
      - ts_seconds   (integer offset from start)
      - watts
      - heartrate
      - cadence
      - velocity_mps

    If `streams` is None → do nothing.
    """

    if streams is None:
        print(f"[Samples] No streams for workout {workout_id}, skipping samples insert.")
        return

    time_stream = streams.get("time", {}).get("data") or []
    watt_stream = streams.get("watts", {}).get("data") or []
    hr_stream   = streams.get("heartrate", {}).get("data") or []
    cad_stream  = streams.get("cadence", {}).get("data") or []
    vel_stream  = streams.get("velocity_smooth", {}).get("data") or []

    if not time_stream:
        print(f"[Samples] No time stream for workout {workout_id}, cannot insert samples.")
        return

    conn = get_connection()
    cur = conn.cursor()

    # Idempotent: wipe any existing samples for this workout
    cur.execute("DELETE FROM workout_samples WHERE workout_id = %s", (workout_id,))

    for i, t in enumerate(time_stream):
        watts = watt_stream[i] if i < len(watt_stream) else None
        hr    = hr_stream[i]   if i < len(hr_stream)   else None
        cad   = cad_stream[i]  if i < len(cad_stream)  else None
        vel   = vel_stream[i]  if i < len(vel_stream)  else None

        cur.execute(
            """
            INSERT INTO workout_samples (
                workout_id,
                ts_seconds,
                watts,
                heartrate,
                cadence,
                velocity_mps
            ) VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (workout_id, t, watts, hr, cad, vel),
        )

    conn.commit()
    cur.close()
    conn.close()

    print(f"[Samples] Inserted {len(time_stream)} samples for workout {workout_id}.")
