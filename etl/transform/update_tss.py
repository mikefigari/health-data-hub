from dotenv import load_dotenv

from utils.db_connect import get_connection

load_dotenv("config/dev.env")


def update_tss():
    """
    Compute NP/IF/TSS using ftp_history effective on workout date.
    NP is approximated as weighted_average_watts falling back to avg_watts.
    TSS = (duration_sec * NP * IF) / (FTP * 3600) * 100 -> simplified to (moving_s * NP^2)/(FTP^2 * 36)
    """
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM ftp_history;")
    ftp_count = cur.fetchone()[0]
    if ftp_count == 0:
        print("No FTP history found; skipping TSS update.")
        cur.close()
        conn.close()
        return

    print("Updating TSS for all workouts using ftp_history...")
    cur.execute(
        """
        UPDATE workout_summary ws
        SET
            np_watts = COALESCE(ws.weighted_average_watts, ws.avg_watts),
            intensity_factor = CASE
                WHEN ftp.ftp_watts > 0 THEN COALESCE(ws.weighted_average_watts, ws.avg_watts) / ftp.ftp_watts
                ELSE NULL
            END,
            tss_power = CASE
                WHEN ftp.ftp_watts > 0 AND ws.moving_s > 0 THEN
                    (ws.moving_s * POWER(COALESCE(ws.weighted_average_watts, ws.avg_watts), 2))
                    / (POWER(ftp.ftp_watts, 2) * 36)
                ELSE NULL
            END
        FROM workouts_raw wr
        CROSS JOIN LATERAL (
            SELECT ftp_watts
            FROM ftp_history
            WHERE effective_from <= DATE(wr.start_time)
            ORDER BY effective_from DESC
            LIMIT 1
        ) AS ftp
        WHERE ws.workout_id = wr.id;
        """
    )
    conn.commit()

    cur.close()
    conn.close()
    print("TSS update complete.")
