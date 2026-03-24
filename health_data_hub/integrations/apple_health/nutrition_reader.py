"""
Read Apple Health nutrition data from the nutrition_daily database table.

Data is written by the webhook receiver when Health Auto Export pushes.

Usage:
    from health_data_hub.integrations.apple_health.nutrition_reader import get_nutrition

    result = get_nutrition("2026-03-24")
    if result["data_present"]:
        print(result["calories"], result["protein_g"])
    else:
        print("Nutrition data not yet received from Apple Health for this date")
"""

from __future__ import annotations

from health_data_hub.utils.db_connect import get_connection


def get_nutrition(date: str) -> dict:
    """
    Read nutrition data for a given date from nutrition_daily.

    Args:
        date: ISO date string, e.g. '2026-03-24'

    Returns a dict with keys:
        data_present  bool   — False if no row exists or calories is null
        calories      int | None
        protein_g     float | None
        carbs_g       float | None
        fat_g         float | None
        fiber_g       float | None
        source        str | None
    """
    _empty = {
        "data_present": False,
        "calories":     None,
        "protein_g":    None,
        "carbs_g":      None,
        "fat_g":        None,
        "fiber_g":      None,
        "source":       None,
    }

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT calories, protein_g, carbs_g, fat_g, fiber_g, source
                FROM nutrition_daily
                WHERE day = %s
                """,
                (date,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if row is None:
        return _empty

    calories, protein_g, carbs_g, fat_g, fiber_g, source = row
    return {
        "data_present": calories is not None,
        "calories":     calories,
        "protein_g":    protein_g,
        "carbs_g":      carbs_g,
        "fat_g":        fat_g,
        "fiber_g":      fiber_g,
        "source":       source,
    }
