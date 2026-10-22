#!/usr/bin/env python3
"""
backfill_body_measurements.py — One-off import of a Health Auto Export file export
into body_measurements.

Use this when the full Apple Health body history arrives as a file rather than
through the "Hub – Body" automation. The file must be an HAE JSON export shaped
like {"data": {"metrics": [...]}} or {"metrics": [...]}. Parsing and upserting reuse
body_poller.parse_body_payloads and insert_body_measurements, so re-running is safe.

Usage:
    python backfill_body_measurements.py <file.json> [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from health_data_hub.etl.load.insert_body_measurements import insert_body_measurements
from health_data_hub.integrations.apple_health.body_poller import parse_body_payloads
from health_data_hub.utils.db_connect import get_connection

BATCH_SIZE = 500


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill body_measurements from an HAE JSON export")
    parser.add_argument("file", type=Path, help="Health Auto Export JSON file")
    parser.add_argument("--dry-run", action="store_true", help="parse and summarise only; no DB writes")
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    with args.file.open() as f:
        body = json.load(f)
    metrics = (body.get("data") or {}).get("metrics") or body.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        print(f"No metrics found in {args.file}", file=sys.stderr)
        return 1

    payload = {"received_at": datetime.now(timezone.utc).isoformat(), "metrics": metrics}
    stats: dict = {}
    rows = parse_body_payloads([payload], stats=stats)

    inserted = 0
    if not args.dry_run and rows:
        conn = get_connection()
        try:
            for i in range(0, len(rows), BATCH_SIZE):
                inserted += insert_body_measurements(conn, rows[i:i + BATCH_SIZE])
        finally:
            conn.close()

    days = sorted({r["local_day"] for r in rows})
    with_weight = sum(1 for r in rows if r["weight_kg"] is not None)
    print(
        f"{'[dry-run] ' if args.dry_run else ''}"
        f"rows={len(rows)} (with weight: {with_weight}), upserted={inserted}, "
        f"days={len(days)}, first_day={days[0] if days else '-'}, last_day={days[-1] if days else '-'}, "
        f"outliers_dropped={stats.get('outliers', 0)}, warnings={stats.get('warnings', 0)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
