"""
Sync the body-weight and nutrition charts to Datawrapper.

Four charts: weight over time (with 7-day average), daily calories vs goal,
daily protein vs goal (both last 14 days), and weekly goal-met day counts.
Each chart's CSV is hashed; only changed charts are re-uploaded and published.
Embed URL for Notion: https://datawrapper.dwcdn.net/<chart_id>/

Usage:
    python -m health_data_hub.integrations.datawrapper.nutrition_charts [--dry-run]
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import sys
from pathlib import Path

from health_data_hub.config.settings import (
    DATAWRAPPER_API_TOKEN,
    NUTRITION_CHARTS_DIR,
)
from health_data_hub.etl.transform import build_nutrition_charts as b
from health_data_hub.integrations.datawrapper.ftp_wkg_charts import (
    API,
    _call,
    _load_state,
    _save_state,
)
from health_data_hub.utils.db_connect import get_connection

logger = logging.getLogger(__name__)

BLUE, ORANGE, GREY, GREEN = "#3B6EA8", "#E08A3C", "#9AA5B1", "#4C9A6A"


def _select(csv_text, indexes):
    """Keep only the given column indexes of a CSV string."""
    out = []
    for line in csv_text.splitlines():
        cells = line.split(",")
        out.append(",".join(cells[i] for i in indexes))
    return "\n".join(out) + "\n"


def _charts(weight, daily, weekly):
    daily_csv = b.daily_csv(daily)
    return {
        "weight": dict(
            title="Body weight", type="d3-lines", csv=b.weight_csv(weight),
            visualize={
                "custom-colors": {"Weight (kg)": GREY, "7-day average (kg)": BLUE},
                "y-grid": "on",
                "line-symbols": True,
                "line-symbols-on": "last",
                "line-widths": {"Weight (kg)": 1, "7-day average (kg)": 3},
            }),
        "calories": dict(
            title="Daily calories vs goal (last 14 days)", type="column-chart",
            csv=_select(daily_csv, [0, 1, 2]),
            visualize={
                "custom-colors": {"Calories": ORANGE, "Calorie goal": GREY},
                "y-grid": "on",
                "value-labels": {"show": "hover"},
            }),
        "protein": dict(
            title="Daily protein vs goal (last 14 days)", type="column-chart",
            csv=_select(daily_csv, [0, 3, 4]),
            visualize={
                "custom-colors": {"Protein (g)": GREEN, "Protein goal (g)": GREY},
                "y-grid": "on",
                "value-labels": {"show": "hover"},
            }),
        "weekly": dict(
            title="Days goal met per week", type="column-chart",
            csv=_select(b.weekly_csv(weekly), [0, 1, 2]),
            visualize={
                "custom-colors": {"Protein goal met": GREEN,
                                  "Calories at or under goal": ORANGE},
                "custom-range-y": ["0", "7"],
                "y-grid": "on",
                "value-labels": {"show": "always"},
            }),
    }


def _metadata(c):
    return {
        "title": c["title"],
        # a chart opened in the editor can get an external-data URL that blanks it
        "externalData": None,
        "metadata": {"visualize": c["visualize"], "publish": {"autoDarkMode": True}},
    }


def sync_once(dry_run: bool = False, today=None) -> int:
    """Returns 0 ok, 1 API/DB error, 2 token missing."""
    if not dry_run and not DATAWRAPPER_API_TOKEN:
        logger.error("DATAWRAPPER_API_TOKEN is not set")
        return 2

    try:
        conn = get_connection()
        try:
            today = today or b.fetch_today(conn)
            weight_rows = b.fetch_weight(conn)
            nutrition = b.fetch_nutrition(conn, today)
        finally:
            conn.close()
        charts = _charts(b.build_weight_rows(weight_rows),
                         b.build_daily_rows(nutrition, today),
                         b.build_weekly_rows(nutrition, today))
    except Exception as e:  # never raise (poll_once convention)
        logger.error("Failed to build nutrition chart data: %s", e)
        return 1

    if dry_run:
        out = Path(NUTRITION_CHARTS_DIR)
        out.mkdir(parents=True, exist_ok=True)
        for key, c in charts.items():
            (out / f"{key}.csv").write_text(c["csv"], encoding="utf-8", newline="")
        logger.info("[dry-run] wrote %d CSVs to %s", len(charts), out)
        return 0

    state = _load_state()
    ids = state.get("nutrition_charts") or {}
    hashes = state.get("nutrition_sha256") or {}
    try:
        for key, c in charts.items():
            digest = hashlib.sha256(c["csv"].encode("utf-8")).hexdigest()
            if ids.get(key) and hashes.get(key) == digest:
                continue
            if not ids.get(key):
                resp = _call("POST", API, json={"title": c["title"], "type": c["type"]})
                ids[key] = resp.json()["id"]
                state["nutrition_charts"] = ids  # persist at once so a retry never re-creates
                _save_state(state)
            cid = ids[key]
            _call("PATCH", f"{API}/{cid}", json=_metadata(c))
            _call("PUT", f"{API}/{cid}/data", data=c["csv"].encode("utf-8"),
                  headers={"Content-Type": "text/csv"})
            _call("POST", f"{API}/{cid}/publish")
            hashes[key] = digest
            state["nutrition_sha256"] = hashes
            _save_state(state)
    except Exception as e:  # never raise (poll_once convention)
        logger.error("Datawrapper nutrition sync failed: %s", e)
        return 1

    logger.info("Nutrition charts: %s", ", ".join(
        f"{k}=https://datawrapper.dwcdn.net/{i}/" for k, i in ids.items()))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="write the CSVs only; no Datawrapper calls")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    return sync_once(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
