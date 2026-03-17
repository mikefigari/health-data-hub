"""
Extraction helpers for MyFitnessPal Day objects.
Pure transformation — no I/O. Converts an MFP Day object into a
clean dict matching the nutrition_daily schema.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any


def extract_daily_nutrition(day_obj: Any, target_date: date, weight_kg: float | None = None) -> dict | None:
    """
    Convert an MFP Day object into a row dict for nutrition_daily.

    Returns None if the day has no logged data or if the object is malformed.
    MFP nutrient key names use full words (e.g. "carbohydrates", not "carbs");
    this function normalises them to match the Postgres column names.
    """
    try:
        totals = day_obj.totals or {}
        goals = day_obj.goals or {}

        calories = totals.get("calories")

        # Return None for completely empty days to avoid storing blank rows
        if not calories and not totals:
            return None

        # Build per-meal breakdown — normalise nutrient keys
        meals_json = {}
        try:
            for meal in day_obj.meals:
                mt = meal.totals or {}
                if mt:
                    meals_json[meal.name] = {
                        "calories": mt.get("calories"),
                        "protein_g": mt.get("protein"),
                        "carbs_g": mt.get("carbohydrates"),
                        "fat_g": mt.get("fat"),
                    }
        except (AttributeError, KeyError, TypeError):
            meals_json = {}

        now = datetime.now(timezone.utc)

        return {
            "day": target_date,
            "calories": calories,
            "protein_g": totals.get("protein"),
            "carbs_g": totals.get("carbohydrates"),
            "fat_g": totals.get("fat"),
            "fiber_g": totals.get("fiber"),
            "sugar_g": totals.get("sugar"),
            "sodium_mg": totals.get("sodium"),
            "goal_calories": goals.get("calories"),
            "goal_protein_g": goals.get("protein"),
            "goal_carbs_g": goals.get("carbohydrates"),
            "goal_fat_g": goals.get("fat"),
            "meals_json": meals_json if meals_json else None,
            "weight_kg": weight_kg,
            "source": "myfitnesspal",
            "logged_complete": getattr(day_obj, "complete", None),
            "created_at": now,
            "updated_at": now,
        }

    except (AttributeError, KeyError, TypeError):
        return None
