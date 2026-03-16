"""
Insert or update Oura heart rate / hrv samples.
"""

from typing import List, Dict, Any
import psycopg2
from psycopg2.extras import Json



SQL = """
INSERT INTO oura_hr_samples (
    sleep_id, timestamp, bpm, hrv_rmssd, source, raw_json
)
VALUES (
    %(sleep_id)s, %(timestamp)s, %(bpm)s, %(hrv_rmssd)s, %(source)s, %(raw_json)s
)
ON CONFLICT (sleep_id, timestamp)
DO UPDATE SET
    bpm = COALESCE(EXCLUDED.bpm, oura_hr_samples.bpm),
    hrv_rmssd = COALESCE(EXCLUDED.hrv_rmssd, oura_hr_samples.hrv_rmssd),
    source = EXCLUDED.source,
    raw_json = EXCLUDED.raw_json;
"""


def insert_oura_hr(conn, rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0

    safe_rows = []
    for r in rows:
        safe = r.copy()
        safe["raw_json"] = Json(r["raw_json"])
        safe_rows.append(safe)

    with conn.cursor() as cur:
        cur.executemany(SQL, safe_rows)

    conn.commit()
    return len(safe_rows)

