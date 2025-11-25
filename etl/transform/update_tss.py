"""
Compute NP, IF, and TSS for all workouts using workout_samples
and update workout_summary.

This version:
  • Uses identical math to your old external TSS calculator
  • Uses effective FTP from ftp_history per workout date
  • Works from VSCode, BAT, Task Scheduler, CLI
"""

from __future__ import annotations

import sys
from pathlib import Path
import numpy as np
from dotenv import load_dotenv

# -------------------------------------------------------------------
# Ensure absolute imports work from ANY execution environment
# -------------------------------------------------------------------

# Path to .../Programming/
PROJECT_PARENT = Path(__file__).resolve().parents[3]

if str(PROJECT_PARENT) not in sys.path:
    sys.path.insert(0, str(PROJECT_PARENT))

# Load dotenv before imports that need connection settings
load_dotenv(PROJECT_PARENT / "health_data_hub" / "config" / "dev.env")

# Now safe to import project modules
from health_data_hub.utils.db_connect import get_connection  # noqa: E402


# ------------------------------------------------------------
# TSS Computation — exact match to your original calculator
# ------------------------------------------------------------

def compute_np_if_tss(watts, ftp_watts):
    """
    Compute NP, IF, and TSS using:
      • 30 second rolling average
      • raise to 4th power
      • mean of rolling 4th
      • NP = mean_4th ** 0.25
      • duration_hours = len(watts) / 3600
      • TSS = (NP**2 * duration_hours) / (FTP**2) * 100
    """
    if not watts or ftp_watts is None or ftp_watts <= 0:
        return None, None, None

    arr = np.array(watts, dtype=float)

    if arr.size < 30:
        return None, None, None

    # 30-second rolling mean (valid windows only)
    kernel = np.ones(30, dtype=float) / 30.0
    rolling_avg = np.convolve(arr, kernel, mode="valid")

    rolling_avg_4th = rolling_avg ** 4
    mean_4th = rolling_avg_4th.mean()

    if np.isnan(mean_4th):
        return None, None, None

    np_val = mean_4th ** 0.25
    duration_hours = arr.size / 3600.0

    if_val = np_val / ftp_watts
    tss_val = (np_val ** 2 * duration_hours) / (ftp_watts ** 2) * 100

    return float(np_val), float(if_val), float(tss_val)


# ------------------------------------------------------------
# Main updater
# ------------------------------------------------------------

def update_tss():
    """
    Recompute NP/IF/TSS for all workouts and update workout_summary.
    """

    conn = get_connection()
    cur = conn.cursor()

    # -----------------------------------------------
    # Ensure FTP exists
    # -----------------------------------------------
    cur.execute("SELECT COUNT(*) FROM ftp_history;")
    if cur.fetchone()[0] == 0:
        print("No FTP history found. TSS update skipped.")
        cur.close()
        conn.close()
        return

    print("Updating NP/IF/TSS using ftp_history and workout_samples...")

        # -----------------------------------------------
    # Fetch each workout with effective FTP
    # -----------------------------------------------
    cur.execute(
        """
        SELECT
            ws.workout_id,
            wr.elapsed_s AS duration_seconds,
            ftp.ftp_watts
        FROM workout_summary ws
        JOIN workouts_raw wr
          ON wr.id = ws.workout_id
        CROSS JOIN LATERAL (
            SELECT ftp_watts
            FROM ftp_history
            WHERE effective_from <= DATE(wr.start_time)
            ORDER BY effective_from DESC
            LIMIT 1
        ) AS ftp
        ORDER BY ws.workout_id;
        """
    )
    workouts = cur.fetchall()


    sample_cur = conn.cursor()
    update_cur = conn.cursor()

    updated = 0
    skipped_no_samples = 0
    skipped_too_short = 0

    # -----------------------------------------------
    # Process each workout
    # -----------------------------------------------
    for workout_id, duration_seconds, ftp_watts in workouts:

        # Fetch per-second watts
        sample_cur.execute(
    """
    SELECT watts
    FROM workout_samples
    WHERE workout_id = %s
      AND watts IS NOT NULL
    ORDER BY ts_seconds
    """,
    (workout_id,),
)



        watts = [row[0] for row in sample_cur.fetchall()]

        if not watts:
            skipped_no_samples += 1
            continue

        np_val, if_val, tss_val = compute_np_if_tss(watts, ftp_watts)

        if np_val is None:
            skipped_too_short += 1
            continue

        update_cur.execute(
            """
            UPDATE workout_summary
            SET
                np_watts = %s,
                intensity_factor = %s,
                tss_power = %s
            WHERE workout_id = %s
            """,
            (np_val, if_val, tss_val, workout_id),
        )

        updated += 1

    conn.commit()

    sample_cur.close()
    update_cur.close()
    cur.close()
    conn.close()

    print(
        f"TSS update complete. "
        f"Updated {updated}. "
        f"Skipped {skipped_no_samples} (no samples). "
        f"Skipped {skipped_too_short} (too short/invalid)."
    )


# ------------------------------------------------------------
# Entrypoint
# ------------------------------------------------------------

if __name__ == "__main__":
    update_tss()
