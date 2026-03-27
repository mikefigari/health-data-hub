"""
CLI entry point: generate and upload the weekly power-zone zone summary chart.

Usage:
    # Current or most-recently-completed week:
    python -m health_data_hub.integrations.sync_weekly_powerzone_summary

    # Specific Monday:
    python -m health_data_hub.integrations.sync_weekly_powerzone_summary 2025-03-17
"""

from __future__ import annotations

import sys
from datetime import date, timedelta

from health_data_hub.integrations.notion.notion_strava_sync import sync_weekly_zone_summary


def _parse_week_start(arg: str) -> date:
    d = date.fromisoformat(arg)
    # Snap to Monday
    return d - timedelta(days=d.weekday())


def main() -> int:
    if len(sys.argv) > 2:
        print(__doc__)
        return 1

    week_start: date | None = None
    if len(sys.argv) == 2:
        try:
            week_start = _parse_week_start(sys.argv[1])
        except ValueError:
            print(f"Invalid date: {sys.argv[1]}. Expected YYYY-MM-DD.")
            return 1

    sync_weekly_zone_summary(week_start)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
