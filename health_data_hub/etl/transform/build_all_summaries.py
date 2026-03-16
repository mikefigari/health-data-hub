"""
Build workout summary rows for all workouts in workouts_raw.
Computes NP, IF, and TSS for each workout via build_summary_for().
Safe to re-run — build_summary_for uses ON CONFLICT DO UPDATE.
"""

from health_data_hub.utils.db_connect import get_connection
from health_data_hub.etl.transform.build_workout_summary import build_summary_for


def build_all_summaries():
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT id FROM workouts_raw ORDER BY start_time;")
    ids = [row[0] for row in cur.fetchall()]
    cur.close()
    conn.close()

    print(f"Building summaries for {len(ids)} workouts...")

    for wid in ids:
        build_summary_for(wid)

    print("Summary build complete.")


if __name__ == "__main__":
    build_all_summaries()
