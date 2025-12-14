"""
Insert or update Oura sleep records.
"""

from typing import List, Dict, Any
import psycopg2
from typing import List, Dict, Any



SQL = """
INSERT INTO oura_sleep_raw (
    sleep_id, day,
    bedtime_start, bedtime_end,
    total_sleep_sec, time_in_bed_sec, deep_sleep_sec, light_sleep_sec,
    rem_sleep_sec, awake_sec,
    efficiency, latency_sec, restless_periods,
    lowest_hr, avg_hr, avg_hrv, avg_breath,
    sleep_phase_5_min,
    raw_json
)
VALUES (
    %(sleep_id)s, %(day)s,
    %(bedtime_start)s, %(bedtime_end)s,
    %(total_sleep_sec)s, %(time_in_bed_sec)s, %(deep_sleep_sec)s, %(light_sleep_sec)s,
    %(rem_sleep_sec)s, %(awake_sec)s,
    %(efficiency)s, %(latency_sec)s, %(restless_periods)s,
    %(lowest_hr)s, %(avg_hr)s, %(avg_hrv)s, %(avg_breath)s,
    %(sleep_phase_5_min)s,
    %(raw_json)s
)
ON CONFLICT (sleep_id)
DO UPDATE SET
    day = EXCLUDED.day,
    bedtime_start = EXCLUDED.bedtime_start,
    bedtime_end = EXCLUDED.bedtime_end,
    total_sleep_sec = EXCLUDED.total_sleep_sec,
    time_in_bed_sec = EXCLUDED.time_in_bed_sec,
    deep_sleep_sec = EXCLUDED.deep_sleep_sec,
    light_sleep_sec = EXCLUDED.light_sleep_sec,
    rem_sleep_sec = EXCLUDED.rem_sleep_sec,
    awake_sec = EXCLUDED.awake_sec,
    efficiency = EXCLUDED.efficiency,
    latency_sec = EXCLUDED.latency_sec,
    restless_periods = EXCLUDED.restless_periods,
    lowest_hr = EXCLUDED.lowest_hr,
    avg_hr = EXCLUDED.avg_hr,
    avg_hrv = EXCLUDED.avg_hrv,
    avg_breath = EXCLUDED.avg_breath,
    sleep_phase_5_min = EXCLUDED.sleep_phase_5_min,
    raw_json = EXCLUDED.raw_json;
"""


def insert_oura_sleep(conn, rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0

    with conn.cursor() as cur:
        cur.executemany(SQL, rows)
    conn.commit()
    return len(rows)
