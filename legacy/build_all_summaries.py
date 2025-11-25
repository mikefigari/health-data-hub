"""
Backfill all workout summaries by scanning workouts_raw and generating
a summary for each row using build_summary_for().
"""

import sys
from pathlib import Path

# -------------------------------------------------------------------
# Ensure health_data_hub package resolves from ANY working directory
# -------------------------------------------------------------------

PROJECT_PARENT = Path(__file__).resolve().parents[3]

if str(PROJECT_PARENT) not in sys.path:
    sys.path.insert(0, str(PROJECT_PARENT))

print(">>> sys.path patched:", PROJECT_PARENT)

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
