from utils.db_connect import get_connection
from datetime import datetime

def build_summary_for(workout_id):
    conn = get_connection()
    cur = conn.cursor()

    # Pull values from workouts_raw using your actual column names
    cur.execute("""
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
    """, (workout_id,))

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
            (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
        ON CONFLICT (workout_id)
        DO NOTHING;
    """

    cur.execute(sql, (workout_id, *row))
    conn.commit()

    cur.close()
    conn.close()
