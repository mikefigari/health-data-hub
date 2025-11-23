from pathlib import Path

from dotenv import load_dotenv

from utils.db_connect import get_connection

load_dotenv(Path(__file__).resolve().parents[2] / "config" / "dev.env")

def build_summary_for(workout_id):
    conn = get_connection()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT
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
            sport_type,
            title,
            start_time,
            total_elevation_gain,
            has_heartrate,
            timezone
        FROM workouts_raw
        WHERE id = %s
        """,
        (workout_id,),
    )

    row = cur.fetchone()
    if not row:
        print(f"No raw data for workout {workout_id}, skipping summary.")
        cur.close()
        conn.close()
        return

    # Insert into workout_summary
    sql = """
        INSERT INTO workout_summary (
            workout_id,
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
            sport_type,
            title,
            start_time,
            total_elevation_gain,
            has_heartrate,
            timezone,
            inserted_at
        )
        VALUES
            (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (workout_id)
        DO UPDATE SET
            distance_m = EXCLUDED.distance_m,
            moving_s = EXCLUDED.moving_s,
            elapsed_s = EXCLUDED.elapsed_s,
            avg_speed = EXCLUDED.avg_speed,
            max_speed = EXCLUDED.max_speed,
            avg_cadence = EXCLUDED.avg_cadence,
            avg_hr = EXCLUDED.avg_hr,
            max_hr = EXCLUDED.max_hr,
            avg_watts = EXCLUDED.avg_watts,
            max_watts = EXCLUDED.max_watts,
            weighted_average_watts = EXCLUDED.weighted_average_watts,
            kj = EXCLUDED.kj,
            device_watts = EXCLUDED.device_watts,
            sport_type = EXCLUDED.sport_type,
            title = EXCLUDED.title,
            start_time = EXCLUDED.start_time,
            total_elevation_gain = EXCLUDED.total_elevation_gain,
            has_heartrate = EXCLUDED.has_heartrate,
            timezone = EXCLUDED.timezone,
            inserted_at = NOW();
    """

    cur.execute(sql, (workout_id, *row))
    conn.commit()

    cur.close()
    conn.close()
