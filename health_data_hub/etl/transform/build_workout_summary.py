"""
Build a single workout summary row in workout_summary
from workouts_raw and workout_samples.

Computes NP, IF, and TSS at insert time using FTP history.
"""

import logging
from typing import Iterable, Optional, Tuple
import numpy as np

from health_data_hub.utils.db_connect import get_connection

logger = logging.getLogger(__name__)


# -------------------------------------------------------------------
# Helper for NP, IF, TSS
# -------------------------------------------------------------------

def _compute_np_if_tss(
    watts_series: Iterable[Optional[float]],
    ftp_watts: Optional[float],
    moving_s: Optional[int],
) -> Tuple[Optional[float], Optional[float], Optional[float]]:

    watts_list = [w if w is not None else 0.0 for w in watts_series]
    if not watts_list:
        return None, None, None

    arr = np.asarray(watts_list, dtype=float)
    if arr.size < 30:
        return None, None, None

    arr = np.nan_to_num(arr, nan=0.0)

    kernel = np.ones(30, dtype=float) / 30.0
    rolling_avg = np.convolve(arr, kernel, mode="valid")

    rolling_avg_4th = rolling_avg ** 4
    mean_4th = rolling_avg_4th.mean()

    if np.isnan(mean_4th):
        return None, None, None

    np_val = float(mean_4th ** 0.25)
    np_val = round(np_val) if np_val is not None else None
    if not ftp_watts or ftp_watts <= 0:
        return np_val, None, None

    intensity_factor = float(np_val / ftp_watts)

    duration_seconds = int(moving_s) if moving_s and moving_s > 0 else arr.size

    tss = float(
        (duration_seconds * np_val * intensity_factor) / (ftp_watts * 3600.0) * 100.0
    )
    tss = round(tss)

    return np_val, intensity_factor, tss


# -------------------------------------------------------------------
# Core function
# -------------------------------------------------------------------

def build_summary_for(workout_id: int) -> None:
    conn = get_connection()
    cur = conn.cursor()

    try:
        cur.execute(
            """
            SELECT
                distance_m, moving_s, elapsed_s, avg_speed, max_speed,
                avg_cadence, avg_hr, max_hr, avg_watts, max_watts,
                weighted_average_watts, kj, device_watts, source,
                sport_type, title, start_time, total_elevation_gain,
                has_heartrate, timezone
            FROM workouts_raw
            WHERE id = %s
            """,
            (workout_id,),
        )

        row = cur.fetchone()
        if not row:
            logger.warning("No raw data for workout %s, skipping.", workout_id)
            return

        (
            distance_m, moving_s, elapsed_s, avg_speed, max_speed,
            avg_cadence, avg_hr, max_hr, avg_watts, max_watts,
            weighted_average_watts, kj, device_watts, source,
            sport_type, title, start_time, total_elevation_gain,
            has_heartrate, timezone,
        ) = row

        # Fetch FTP for workout date
        ftp_watts = None
        if start_time:
            cur.execute(
                """
                SELECT ftp_watts FROM ftp_history
                WHERE effective_from <= %s::date
                ORDER BY effective_from DESC
                LIMIT 1
                """,
                (start_time.date(),),
            )
            ftp_row = cur.fetchone()
            if ftp_row:
                ftp_watts = ftp_row[0]

        if ftp_watts is None:
            cur.execute(
                "SELECT ftp_watts FROM ftp_history ORDER BY effective_from DESC LIMIT 1"
            )
            ftp_row = cur.fetchone()
            ftp_watts = ftp_row[0] if ftp_row else None

        # Fetch watt samples
        cur.execute(
            "SELECT watts FROM workout_samples WHERE workout_id = %s ORDER BY ts_seconds",
            (workout_id,),
        )
        watts_series = [r[0] for r in cur.fetchall()]

        np_watts, intensity_factor, tss_power = _compute_np_if_tss(
            watts_series, ftp_watts, moving_s
        )

        cur.execute(
            """
            INSERT INTO workout_summary (
                workout_id, distance_m, moving_s, elapsed_s,
                avg_speed, max_speed, avg_cadence, avg_hr, max_hr,
                avg_watts, max_watts, weighted_average_watts, kj,
                device_watts, sport_type, title, start_time,
                total_elevation_gain, has_heartrate, timezone,
                np_watts, intensity_factor, tss_power
            )
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (workout_id) DO UPDATE SET
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
                np_watts = EXCLUDED.np_watts,
                intensity_factor = EXCLUDED.intensity_factor,
                tss_power = EXCLUDED.tss_power,
                inserted_at = NOW()
            """,
            (
                workout_id, distance_m, moving_s, elapsed_s,
                avg_speed, max_speed, avg_cadence, avg_hr, max_hr,
                avg_watts, max_watts, weighted_average_watts, kj,
                device_watts, sport_type, title, start_time,
                total_elevation_gain, has_heartrate, timezone,
                np_watts, intensity_factor, tss_power,
            ),
        )

        conn.commit()
        logger.info(
            "Summary built for workout %s: NP=%s, IF=%s, TSS=%s",
            workout_id, np_watts, intensity_factor, tss_power,
        )

    finally:
        cur.close()
        conn.close()


# -------------------------------------------------------------------
# CLI entrypoint
# -------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()

    if len(sys.argv) != 2:
        print("Usage: python -m health_data_hub.etl.transform.build_workout_summary <workout_id>")
        sys.exit(1)

    build_summary_for(int(sys.argv[1]))
