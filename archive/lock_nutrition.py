#!/usr/bin/env python3
"""
lock_nutrition.py — Nightly nutrition data presence check.

Runs at 23:55 daily (cron). Checks whether a nutrition row has been
received from Apple Health for today. Logs a confirmation if present,
or a WARNING if the day is ending without any nutrition data.

Usage:
    python lock_nutrition.py
    # or via cron:
    # 55 23 * * * cd /home/mike/projects/health-data-hub && /usr/bin/python3 lock_nutrition.py >> /home/mike/logs/nutrition-lock.log 2>&1
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from health_data_hub.integrations.apple_health.nutrition_reader import get_nutrition


def main() -> None:
    today = date.today().isoformat()
    result = get_nutrition(today)

    if result["data_present"]:
        kcal = result["calories"]
        protein = result["protein_g"]
        print(
            f"[{today}] LOCKED — nutrition data present: "
            f"{kcal} kcal, {protein}g protein"
        )
    else:
        print(
            f"[{today}] WARNING — no nutrition data received from Apple Health for today"
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
