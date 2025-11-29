"""
Insert or update Oura daily activity records.
"""

from typing import List, Dict, Any
from psycopg import Connection


SQL = """
INSERT INTO oura_activity_raw (
    activity_id, day,
    steps, cal_total, cal_active,
    inactive_sec, low_activity_sec, medium_activity_sec, high_activity_sec,
    met_min_low, met_min_medium, met_min_high,
    raw_json
)
VALUES (
    %(activity_id)s, %(day)s,
    %(steps)s, %(cal_total)s, %(cal_active)s,
    %(inactive_sec)s, %(low_activity_sec)s, %(medium_activity_sec)s, %(high_activity_sec)s,
    %(met_min_low)s, %(met_min_medium)s, %(met_min_high)s,
    %(raw_json)s
)
ON CONFLICT (day)
DO UPDATE SET
    steps = EXCLUDED.steps,
    cal_total = EXCLUDED.cal_total,
    cal_active = EXCLUDED.cal_active,
    inactive_sec = EXCLUDED.inactive_sec,
    low_activity_sec = EXCLUDED.low_activity_sec,
    medium_activity_sec = EXCLUDED.medium_activity_sec,
    high_activity_sec = EXCLUDED.high_activity_sec,
    met_min_low = EXCLUDED.met_min_low,
    met_min_medium = EXCLUDED.met_min_medium,
    met_min_high = EXCLUDED.met_min_high,
    raw_json = EXCLUDED.raw_json;
"""


def insert_oura_activity(conn: Connection, rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0

    with conn.cursor() as cur:
        cur.executemany(SQL, rows)
    conn.commit()
    return len(rows)
