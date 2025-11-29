"""
Insert or update Oura heart rate / hrv samples.
"""

from typing import List, Dict, Any
from psycopg import Connection


SQL = """
INSERT INTO oura_hr_samples (
    sleep_id, timestamp, bpm, hrv_rmssd, source, raw_json
)
VALUES (
    %(sleep_id)s, %(timestamp)s, %(bpm)s, %(hrv_rmssd)s, %(source)s, %(raw_json)s
)
ON CONFLICT (sleep_id, timestamp)
DO UPDATE SET
    bpm = EXCLUDED.bpm,
    hrv_rmssd = EXCLUDED.hrv_rmssd,
    source = EXCLUDED.source,
    raw_json = EXCLUDED.raw_json;
"""


def insert_oura_hr(conn: Connection, rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0

    with conn.cursor() as cur:
        cur.executemany(SQL, rows)
    conn.commit()
    return len(rows)
