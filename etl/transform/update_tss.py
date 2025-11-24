import numpy as np
from dotenv import load_dotenv

from utils.db_connect import get_connection

# Load env (DB settings)
load_dotenv("config/dev.env")


# ------------------------------------------------------------
# Core math – match your old TSS calculator exactly
# ------------------------------------------------------------

def compute_np_if_tss(watts, ftp_watts):
    """
    Compute NP, IF, TSS from a list of per-second watts and FTP.

    This reproduces your old script:

        - 30 second rolling mean
        - raise to 4th power
        - mean of 4th powers
        - 4th-root = NP
        - duration_hours = len(watts) / 3600
        - TSS = (NP**2 * duration_hours) / (FTP**2) * 100
    """
    if not watts or ftp_watts is None or ftp_watts <= 0:
        return None, None, None

    arr = np.array(watts, dtype=float)

    # Need at least 30 seconds for a 30-second rolling window
    if arr.size < 30:
        return None, None, None

    # 30-second rolling average, equivalent to pandas .rolling(30).mean() (valid windows only)
    kernel = np.ones(30, dtype=float) / 30.0
    rolling_avg = np.convolve(arr, kernel, mode="valid")  # length = N - 29

    # 4th power and mean
    rolling_avg_4th = rolling_avg ** 4
    mean_4th = rolling_avg_4th.mean()

    if np.isnan(mean_4th):
        return None, None, None

    np_val = mean_4th ** 0.25  # normalized power

    # Duration in hours – your data is 1 row per second
    duration_hours = arr.size / 3600.0

    if_val = np_val / ftp_watts
    tss_val = (np_val ** 2 * duration_hours) / (ftp_watts ** 2) * 100.0

    return float(np_val), float(if_val), float(tss_val)


# ------------------------------------------------------------
# DB updater
# ------------------------------------------------------------

def update_tss():
    """
    Recompute NP, IF, TSS for all workouts using:
      - samples from workout_samples (1 Hz power)
      - FTP from ftp_history effective on workout date
      - NP/TSS formulas identical to your old TSS calculator
    """
    conn = get_connection()
    cur = conn.cursor()

    # Ensure we actually have FTP history
    cur.execute("SELECT COUNT(*) FROM ftp_history;")
    ftp_count = cur.fetchone()[0]
    if ftp_count == 0:
        print("No FTP history found; skipping TSS update.")
        cur.close()
        conn.close()
        return

    print("Updating NP/IF/TSS for all workouts using ftp_history and samples...")

    # Get each workout and its effective FTP
    cur.execute(
        """
        SELECT
            ws.workout_id,
            ftp.ftp_watts
        FROM workout_summary ws
        JOIN workouts_raw wr
          ON ws.workout_id = wr.id
        CROSS JOIN LATERAL (
            SELECT ftp_watts
            FROM ftp_history
            WHERE effective_from <= DATE(wr.start_time)
            ORDER BY effective_from DESC
            LIMIT 1
        ) AS ftp
        """
    )
    workouts = cur.fetchall()

    sample_cur = conn.cursor()
    update_cur = conn.cursor()

    updated = 0
    skipped_no_samples = 0
    skipped_too_short = 0

    for workout_id, ftp_watts in workouts:
        # Fetch per-second watts for this workout
        sample_cur.execute(
            """
            SELECT watts
            FROM workout_samples
            WHERE workout_id = %s
              AND watts IS NOT NULL
            ORDER BY ts
            """,
            (workout_id,),
        )
        watts_rows = sample_cur.fetchall()
        watts = [row[0] for row in watts_rows]

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
        f"Updated {updated} workouts. "
        f"Skipped {skipped_no_samples} (no samples), "
        f"{skipped_too_short} (too short / invalid)."
    )


if __name__ == "__main__":
    update_tss()
