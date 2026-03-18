"""
Import planned workouts from a CSV file into the planned_workouts table.

Usage:
    python -m health_data_hub.etl.import_planned_workouts planned_workouts.csv

CSV format (header required):
    planned_date,class_type,duration_min,estimated_tss,notes

Upserts on (planned_date, class_type) — safe to re-import after edits.
"""

from __future__ import annotations

import csv
import sys
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path

import psycopg2

from health_data_hub.utils.db_connect import get_connection

_UPSERT_SQL = """
INSERT INTO planned_workouts
    (planned_date, class_type, duration_min, estimated_tss, notes)
VALUES
    (%(planned_date)s, %(class_type)s, %(duration_min)s, %(estimated_tss)s, %(notes)s)
ON CONFLICT (planned_date, class_type)
DO UPDATE SET
    duration_min  = EXCLUDED.duration_min,
    estimated_tss = EXCLUDED.estimated_tss,
    notes         = EXCLUDED.notes,
    updated_at    = NOW()
RETURNING
    xmax = 0 AS is_insert;
"""

REQUIRED_COLUMNS = {"planned_date", "class_type", "duration_min", "estimated_tss", "notes"}


def _parse_row(row: dict, lineno: int) -> dict | None:
    """Validate and coerce a CSV row. Returns None and prints error on bad data."""
    errors = []

    # --- planned_date ---
    raw_date = row.get("planned_date", "").strip()
    try:
        parsed_date = date.fromisoformat(raw_date)
    except ValueError:
        errors.append(f"  planned_date '{raw_date}' is not a valid YYYY-MM-DD date")
        parsed_date = None

    # --- class_type ---
    class_type = row.get("class_type", "").strip() or None

    # --- duration_min ---
    raw_duration = row.get("duration_min", "").strip()
    if raw_duration == "" or raw_duration is None:
        duration_min = None
    else:
        try:
            duration_min = int(raw_duration)
            if duration_min < 0:
                errors.append(f"  duration_min '{raw_duration}' must be non-negative")
                duration_min = None
        except ValueError:
            errors.append(f"  duration_min '{raw_duration}' is not a valid integer")
            duration_min = None

    # --- estimated_tss ---
    raw_tss = row.get("estimated_tss", "").strip()
    if raw_tss == "" or raw_tss is None:
        estimated_tss = None
    else:
        try:
            estimated_tss = Decimal(raw_tss)
            if estimated_tss < 0:
                errors.append(f"  estimated_tss '{raw_tss}' must be non-negative")
                estimated_tss = None
        except InvalidOperation:
            errors.append(f"  estimated_tss '{raw_tss}' is not a valid number")
            estimated_tss = None

    # --- notes ---
    notes = row.get("notes", "").strip() or None

    if errors:
        print(f"[ERROR] Row {lineno}: skipping due to validation error(s):")
        for e in errors:
            print(e)
        return None

    return {
        "planned_date": parsed_date,
        "class_type":   class_type,
        "duration_min": duration_min,
        "estimated_tss": estimated_tss,
        "notes":        notes,
    }


def import_planned_workouts(csv_path: str | Path) -> None:
    csv_path = Path(csv_path)
    if not csv_path.exists():
        print(f"[ERROR] File not found: {csv_path}")
        sys.exit(1)

    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)

        # Validate header
        if reader.fieldnames is None:
            print("[ERROR] CSV file appears to be empty.")
            sys.exit(1)
        header_cols = {c.strip() for c in reader.fieldnames}
        missing = REQUIRED_COLUMNS - header_cols
        if missing:
            print(f"[ERROR] CSV is missing required columns: {sorted(missing)}")
            sys.exit(1)

        rows = list(reader)

    if not rows:
        print("[INFO] CSV has a header but no data rows — nothing to import.")
        return

    # Parse and validate all rows before touching the DB
    parsed = []
    for lineno, raw_row in enumerate(rows, start=2):  # 2 = first data row (1 = header)
        p = _parse_row(raw_row, lineno)
        if p is not None:
            parsed.append(p)

    bad_count = len(rows) - len(parsed)
    if bad_count:
        print(f"[WARN] {bad_count} row(s) skipped due to validation errors.")

    if not parsed:
        print("[INFO] No valid rows to import.")
        return

    # Upsert
    inserted = 0
    unchanged = 0

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            for p in parsed:
                cur.execute(_UPSERT_SQL, p)
                result = cur.fetchone()
                # is_insert is True for new rows, False for updates/no-change
                if result and result[0]:
                    inserted += 1
                else:
                    unchanged += 1
        conn.commit()
    except psycopg2.Error as exc:
        conn.rollback()
        print(f"[ERROR] Database error: {exc}")
        sys.exit(1)
    finally:
        conn.close()

    total = inserted + unchanged
    print(f"[OK] {total} rows processed: {inserted} upserted, {unchanged} unchanged.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python -m health_data_hub.etl.import_planned_workouts <path/to/file.csv>")
        sys.exit(1)
    import_planned_workouts(sys.argv[1])
