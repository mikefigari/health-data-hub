"""
Insert or update body measurements (Renpho scale via Apple Health / Health Auto Export).

One row per weigh-in timestamp, keyed on (source, measured_at). Re-ingesting the
same weigh-in only fills in fields that are non-null in the new data.
"""

from typing import List, Dict, Any

from psycopg2.extras import Json


SQL = """
INSERT INTO body_measurements
    (measured_at, local_day, source, source_device, weight_kg, body_fat_pct,
     lean_mass_kg, muscle_mass_kg, water_pct, bmi, raw_json)
VALUES (%(measured_at)s, %(local_day)s, %(source)s, %(source_device)s, %(weight_kg)s,
        %(body_fat_pct)s, %(lean_mass_kg)s, %(muscle_mass_kg)s, %(water_pct)s,
        %(bmi)s, %(raw_json)s)
ON CONFLICT (source, measured_at) DO UPDATE SET
    local_day      = EXCLUDED.local_day,
    source_device  = COALESCE(EXCLUDED.source_device,  body_measurements.source_device),
    weight_kg      = COALESCE(EXCLUDED.weight_kg,      body_measurements.weight_kg),
    body_fat_pct   = COALESCE(EXCLUDED.body_fat_pct,   body_measurements.body_fat_pct),
    lean_mass_kg   = COALESCE(EXCLUDED.lean_mass_kg,   body_measurements.lean_mass_kg),
    muscle_mass_kg = COALESCE(EXCLUDED.muscle_mass_kg, body_measurements.muscle_mass_kg),
    water_pct      = COALESCE(EXCLUDED.water_pct,      body_measurements.water_pct),
    bmi            = COALESCE(EXCLUDED.bmi,            body_measurements.bmi),
    raw_json       = EXCLUDED.raw_json,
    updated_at     = NOW();
"""


def insert_body_measurements(conn, rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0

    safe_rows = []
    for r in rows:
        safe = r.copy()
        safe["raw_json"] = Json(r["raw_json"]) if r.get("raw_json") is not None else None
        safe_rows.append(safe)

    with conn.cursor() as cur:
        cur.executemany(SQL, safe_rows)

    conn.commit()
    return len(safe_rows)
