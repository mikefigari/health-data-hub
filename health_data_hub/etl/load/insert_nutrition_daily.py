"""
Insert or update daily nutrition records from MyFitnessPal.
"""

from typing import List, Dict, Any

from psycopg2.extras import Json


SQL = """
INSERT INTO nutrition_daily
    (day, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
     goal_calories, goal_protein_g, goal_carbs_g, goal_fat_g,
     meals_json, source, logged_complete, created_at, updated_at)
VALUES (
    %(day)s, %(calories)s, %(protein_g)s, %(carbs_g)s, %(fat_g)s,
    %(fiber_g)s, %(sugar_g)s, %(sodium_mg)s,
    %(goal_calories)s, %(goal_protein_g)s, %(goal_carbs_g)s, %(goal_fat_g)s,
    %(meals_json)s, %(source)s, %(logged_complete)s, %(created_at)s, %(updated_at)s
)
ON CONFLICT (day) DO UPDATE SET
    calories        = EXCLUDED.calories,
    protein_g       = EXCLUDED.protein_g,
    carbs_g         = EXCLUDED.carbs_g,
    fat_g           = EXCLUDED.fat_g,
    fiber_g         = EXCLUDED.fiber_g,
    sugar_g         = EXCLUDED.sugar_g,
    sodium_mg       = EXCLUDED.sodium_mg,
    goal_calories   = EXCLUDED.goal_calories,
    goal_protein_g  = EXCLUDED.goal_protein_g,
    goal_carbs_g    = EXCLUDED.goal_carbs_g,
    goal_fat_g      = EXCLUDED.goal_fat_g,
    meals_json      = EXCLUDED.meals_json,
    source          = EXCLUDED.source,
    logged_complete = EXCLUDED.logged_complete,
    updated_at      = NOW();
"""


def insert_nutrition_daily(conn, rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0

    safe_rows = []
    for r in rows:
        safe = r.copy()
        safe["meals_json"] = Json(r["meals_json"]) if r.get("meals_json") is not None else None
        safe_rows.append(safe)

    with conn.cursor() as cur:
        cur.executemany(SQL, safe_rows)

    conn.commit()
    return len(safe_rows)
