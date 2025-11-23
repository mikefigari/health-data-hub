from pathlib import Path

from dotenv import load_dotenv

from utils.db_connect import get_connection
from etl.transform.build_workout_summary import build_summary_for

load_dotenv(Path(__file__).resolve().parents[2] / "config" / "dev.env")

def build_all_summaries():
    conn = get_connection()
    cur = conn.cursor()

    # Get all workouts in workouts_raw
    cur.execute("SELECT id FROM workouts_raw ORDER BY start_time;")
    ids = [row[0] for row in cur.fetchall()]

    cur.close()
    conn.close()

    print(f"Building summaries for {len(ids)} workouts...")

    for wid in ids:
        build_summary_for(wid)

    print("Summary build complete.")
