"""
Import MFP nutrition data from a CSV export file.

Plan B fallback if python-myfitnesspal breaks. Uses the same loader as the
API path so schema behaviour is identical.

MFP CSV export: Settings → Export Data → Download CSV
Expected columns: Date, Meal, Calories, Carbohydrates (g), Fat (g), Protein (g),
                  Sodium (mg), Sugar (g), Fiber (g)

Usage:
    python -m health_data_hub.integrations.mfp.import_mfp_csv path/to/export.csv
"""

from __future__ import annotations

import csv
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from health_data_hub.etl.load.insert_nutrition_daily import insert_nutrition_daily
from health_data_hub.utils.db_connect import get_connection


# MFP CSV column → internal key
_COL_MAP = {
    "Calories": "calories",
    "Carbohydrates (g)": "carbs_g",
    "Fat (g)": "fat_g",
    "Protein (g)": "protein_g",
    "Sodium (mg)": "sodium_mg",
    "Sugar (g)": "sugar_g",
    "Fiber (g)": "fiber_g",
}

# Rows whose Meal value indicate day-level totals/goals — skip them
_SKIP_MEAL_VALUES = {"Daily Totals", "Totals", ""}


def _to_float(val: str) -> float | None:
    try:
        return float(val.replace(",", "").strip())
    except (ValueError, AttributeError):
        return None


def _to_int(val: str) -> int | None:
    f = _to_float(val)
    return int(f) if f is not None else None


def import_csv(csv_path: str | Path) -> int:
    """
    Parse MFP CSV export and upsert into nutrition_daily.
    Returns count of rows upserted.
    """
    csv_path = Path(csv_path)
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV file not found: {csv_path}")

    # day_str → {meal_name → {nutrient → value}}
    by_day: dict[str, dict] = defaultdict(lambda: {
        "meals": {},
        "totals": defaultdict(float),
    })

    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            day_str = row.get("Date", "").strip()
            meal = row.get("Meal", "").strip()

            if not day_str or meal in _SKIP_MEAL_VALUES:
                continue

            entry = by_day[day_str]
            meal_totals = {}
            for csv_col, key in _COL_MAP.items():
                val = _to_float(row.get(csv_col, ""))
                if val is not None:
                    entry["totals"][key] = entry["totals"].get(key, 0.0) + val
                    meal_totals[key] = val

            if meal_totals:
                entry["meals"][meal] = meal_totals

    now = datetime.now(timezone.utc)
    rows = []
    for day_str, entry in sorted(by_day.items()):
        try:
            target_date = date.fromisoformat(day_str)
        except ValueError:
            print(f"Skipping unrecognised date: {day_str!r}")
            continue

        totals = entry["totals"]
        meals = entry["meals"]

        rows.append({
            "day": target_date,
            "calories": _to_int(str(totals.get("calories", ""))) if totals.get("calories") else None,
            "protein_g": totals.get("protein_g"),
            "carbs_g": totals.get("carbs_g"),
            "fat_g": totals.get("fat_g"),
            "fiber_g": totals.get("fiber_g"),
            "sugar_g": totals.get("sugar_g"),
            "sodium_mg": totals.get("sodium_mg"),
            "goal_calories": None,
            "goal_protein_g": None,
            "goal_carbs_g": None,
            "goal_fat_g": None,
            "meals_json": meals if meals else None,
            "source": "myfitnesspal_csv",
            "logged_complete": None,
            "created_at": now,
            "updated_at": now,
        })

    if not rows:
        print("No rows parsed from CSV.")
        return 0

    conn = get_connection()
    try:
        upserted = insert_nutrition_daily(conn, rows)
        print(f"Upserted {upserted} rows from CSV into nutrition_daily.")
        return upserted
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python -m health_data_hub.integrations.mfp.import_mfp_csv path/to/export.csv")
        sys.exit(1)
    import_csv(sys.argv[1])
