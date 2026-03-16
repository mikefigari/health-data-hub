"""
Insert or update daily_physical_state records from Notion.
"""

from typing import List, Dict, Any


SQL = """
INSERT INTO daily_physical_state
    (day, notion_page_id, overall_state, energy_level, body_signals,
     notes, source, entry_confidence, created_at, updated_at)
VALUES (
    %(day)s, %(notion_page_id)s, %(overall_state)s, %(energy_level)s, %(body_signals)s,
    %(notes)s, %(source)s, %(entry_confidence)s, %(created_at)s, %(updated_at)s
)
ON CONFLICT (day) DO UPDATE SET
    notion_page_id   = EXCLUDED.notion_page_id,
    overall_state    = EXCLUDED.overall_state,
    energy_level     = EXCLUDED.energy_level,
    body_signals     = EXCLUDED.body_signals,
    notes            = EXCLUDED.notes,
    source           = EXCLUDED.source,
    entry_confidence = EXCLUDED.entry_confidence,
    updated_at       = EXCLUDED.updated_at;
"""


def insert_daily_physical_state(conn, rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0

    with conn.cursor() as cur:
        cur.executemany(SQL, rows)

    conn.commit()
    return len(rows)
