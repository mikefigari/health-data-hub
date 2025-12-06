"""
Insert or update Oura readiness records.
"""

from typing import List, Dict, Any
import psycopg2
from typing import List, Dict, Any



SQL = """
INSERT INTO oura_readiness_raw (
    day, score, temp_dev, temp_trend_dev,
    r_activity_balance, r_body_temp, r_hrv_balance,
    r_prev_day_activity, r_prev_night, r_recovery_index,
    r_resting_hr, r_sleep_balance,
    raw_json
)
VALUES (
    %(day)s, %(score)s, %(temp_dev)s, %(temp_trend_dev)s,
    %(r_activity_balance)s, %(r_body_temp)s, %(r_hrv_balance)s,
    %(r_prev_day_activity)s, %(r_prev_night)s, %(r_recovery_index)s,
    %(r_resting_hr)s, %(r_sleep_balance)s,
    %(raw_json)s
)
ON CONFLICT (day)
DO UPDATE SET
    score = EXCLUDED.score,
    temp_dev = EXCLUDED.temp_dev,
    temp_trend_dev = EXCLUDED.temp_trend_dev,
    r_activity_balance = EXCLUDED.r_activity_balance,
    r_body_temp = EXCLUDED.r_body_temp,
    r_hrv_balance = EXCLUDED.r_hrv_balance,
    r_prev_day_activity = EXCLUDED.r_prev_day_activity,
    r_prev_night = EXCLUDED.r_prev_night,
    r_recovery_index = EXCLUDED.r_recovery_index,
    r_resting_hr = EXCLUDED.r_resting_hr,
    r_sleep_balance = EXCLUDED.r_sleep_balance,
    raw_json = EXCLUDED.raw_json;
"""


def insert_oura_readiness(conn: Connection, rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0

    with conn.cursor() as cur:
        cur.executemany(SQL, rows)
    conn.commit()
    return len(rows)
