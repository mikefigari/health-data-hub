"""
Apple Health body-measurement poller (Renpho scale -> Apple Health -> Health Auto Export).

Polls GET {HEALTH_WORKER_URL}/body?since=YYYY-MM-DD at :20 past every hour, 6 AM - 11 PM,
via scheduler_all.py. The Worker stores Health Auto Export payloads raw; all parsing
happens here. Each weigh-in becomes one row in body_measurements (upsert on
(source, measured_at)), so overlapping payloads are safe to re-ingest.

Exit behaviour (when run directly):
    0 — success (rows upserted, or no data yet)
    1 — request or DB error

Usage (manual):
    python -m health_data_hub.integrations.apple_health.body_poller [--dry-run] [--days-back N]
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
from datetime import date, datetime, timedelta
from typing import Any, Optional

import psycopg2
import requests

from health_data_hub.config.settings import HEALTH_TOKEN, HEALTH_WORKER_URL
from health_data_hub.etl.load.insert_body_measurements import insert_body_measurements
from health_data_hub.utils.db_connect import get_connection

logger = logging.getLogger(__name__)

# Normalised HAE metric name -> internal kind
METRIC_MAP = {
    "weight_body_mass":    "weight",
    "body_mass":           "weight",
    "weight":              "weight",
    "body_fat_percentage": "body_fat",
    "lean_body_mass":      "lean_mass",
    "body_mass_index":     "bmi",
}

# Internal kind -> output column
FIELD_FOR_KIND = {
    "weight":    "weight_kg",
    "body_fat":  "body_fat_pct",
    "lean_mass": "lean_mass_kg",
    "bmi":       "bmi",
}

# Plausibility bounds, applied after unit conversion
BOUNDS = {
    "weight_kg":    (30.0, 250.0),
    "body_fat_pct": (3.0, 60.0),
    "lean_mass_kg": (20.0, 150.0),
    "bmi":          (10.0, 70.0),
}

DECIMALS = {"weight_kg": 2, "lean_mass_kg": 2, "body_fat_pct": 1, "bmi": 1}

LB_TO_KG = 0.45359237
MERGE_WINDOW = timedelta(minutes=15)
MEASUREMENT_FIELDS = ("weight_kg", "body_fat_pct", "lean_mass_kg", "muscle_mass_kg", "water_pct", "bmi")


def _normalise_name(raw: Optional[str]) -> str:
    """Same normalisation as the Worker: lowercase, whitespace/hyphens -> underscore."""
    return re.sub(r"[\s\-]+", "_", (raw or "").lower())


def _parse_ts(raw: Any) -> Optional[datetime]:
    """Parse an HAE timestamp. Returns None (with a WARNING) for unparseable or naive values."""
    if raw is None:
        logger.warning("Body sample has no date; skipping")
        return None
    s = str(raw).strip()
    try:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")
    except ValueError:
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            logger.warning("Unparseable body sample date %r; skipping", s)
            return None
    if dt.tzinfo is None or dt.utcoffset() is None:
        logger.warning("Naive body sample date %r (no UTC offset); skipping", s)
        return None
    return dt


def _convert(kind: str, units: Optional[str], qty: float) -> Optional[float]:
    """Convert a raw qty to the output unit. Returns None (with a WARNING) for unknown units."""
    if kind in ("weight", "lean_mass"):
        u = (units or "").strip().lower()
        if u in ("lb", "lbs"):
            return qty * LB_TO_KG
        if u == "kg":
            return qty
        logger.warning("Unknown %s unit %r; skipping sample", kind, units)
        return None
    if kind == "body_fat":
        # HealthKit may report body fat as a fraction (0.21) rather than a percentage (21)
        return qty * 100 if 0 < qty <= 1 else qty
    return qty  # bmi


def parse_body_payloads(
    payloads: list[dict],
    source: str = "apple_health",
    *,
    stats: Optional[dict] = None,
) -> list[dict]:
    """
    Turn Worker body payloads into body_measurements rows.

    Each payload is {received_at, metrics:[{name, units, data:[{date, qty, source?}]}]}.
    Pure function (no I/O). If `stats` is given it is filled with counters:
    samples, outliers, warnings, unknown_metrics.
    """
    st = {"samples": 0, "outliers": 0, "warnings": 0, "unknown_metrics": 0}
    if not payloads:
        if stats is not None:
            stats.update(st)
        return []

    unknown_seen: set[str] = set()

    # 1. Collect samples, de-duplicated across overlapping payloads.
    #    key (kind, utc instant) -> sample; later payloads overwrite non-null fields.
    samples: dict[tuple[str, datetime], dict] = {}
    ordered = sorted(payloads, key=lambda p: str(p.get("received_at") or ""))
    for payload in ordered:
        received_at = payload.get("received_at")
        for metric in payload.get("metrics") or []:
            raw_name = metric.get("name")
            name = _normalise_name(raw_name)
            kind = METRIC_MAP.get(name)
            if kind is None:
                if name not in unknown_seen:
                    unknown_seen.add(name)
                    st["unknown_metrics"] += 1
                    st["warnings"] += 1
                    logger.warning("Skipping unknown body metric %r", raw_name)
                continue
            units = metric.get("units")
            for entry in metric.get("data") or []:
                if not isinstance(entry, dict):
                    continue
                dt = _parse_ts(entry.get("date", entry.get("startDate")))
                if dt is None:
                    st["warnings"] += 1
                    continue
                qty = entry.get("qty")
                try:
                    qty = float(qty) if qty is not None else None
                except (TypeError, ValueError):
                    qty = None
                value = _convert(kind, units, qty) if qty is not None else None
                if qty is not None and value is None:
                    st["warnings"] += 1

                key = (kind, dt.timestamp())  # UTC instant
                raw = {"metric": raw_name, "units": units, "entry": entry, "received_at": received_at}
                prev = samples.get(key)
                if prev is None:
                    samples[key] = {
                        "kind": kind,
                        "dt": dt,
                        "local_day": dt.date(),
                        "value": value,
                        "source_device": entry.get("source"),
                        "raw": raw,
                    }
                else:
                    if value is not None:
                        prev["value"] = value
                    if entry.get("source"):
                        prev["source_device"] = entry.get("source")
                    prev["dt"] = dt
                    prev["local_day"] = dt.date()
                    prev["raw"] = raw  # keep only the latest entry per metric

    st["samples"] = len(samples)

    # 2. Plausibility + rounding on de-duplicated samples
    for s in samples.values():
        if s["value"] is None:
            continue
        field = FIELD_FOR_KIND[s["kind"]]
        lo, hi = BOUNDS[field]
        if not (lo <= s["value"] <= hi):
            logger.warning(
                "Out-of-bounds %s on %s (outside [%s, %s]); dropping value",
                field, s["local_day"], lo, hi,
            )
            st["outliers"] += 1
            st["warnings"] += 1
            s["value"] = None
            continue
        s["value"] = round(s["value"], DECIMALS[field])

    # 3. Build rows: one per weight sample, then attach composition samples
    def new_row(sample: dict) -> dict:
        return {
            "measured_at":    sample["dt"],
            "local_day":      sample["local_day"],
            "source":         source,
            "source_device":  sample["source_device"],
            "weight_kg":      None,
            "body_fat_pct":   None,
            "lean_mass_kg":   None,
            "muscle_mass_kg": None,
            "water_pct":      None,
            "bmi":            None,
            "_raw":           {},
            "_dist":          {},
        }

    rows: dict[float, dict] = {}
    weight_rows_by_day: dict[date, list[dict]] = {}

    for (kind, ts), s in sorted(samples.items(), key=lambda kv: kv[0][1]):
        if kind != "weight":
            continue
        row = rows.get(ts)
        if row is None:
            row = new_row(s)
            rows[ts] = row
            weight_rows_by_day.setdefault(s["local_day"], []).append(row)
        row["weight_kg"] = s["value"]
        if s["source_device"]:
            row["source_device"] = s["source_device"]
        row["_raw"][s["raw"]["metric"]] = s["raw"]

    for (kind, ts), s in sorted(samples.items(), key=lambda kv: kv[0][1]):
        if kind == "weight":
            continue
        field = FIELD_FOR_KIND[kind]
        best, best_dist = None, None
        for row in weight_rows_by_day.get(s["local_day"], []):
            dist = abs(row["measured_at"] - s["dt"])
            if dist <= MERGE_WINDOW and (best_dist is None or dist < best_dist):
                best, best_dist = row, dist
        if best is None:
            target = rows.get(ts)
            if target is None:
                target = new_row(s)
                rows[ts] = target
            dist = timedelta(0)
        else:
            target, dist = best, best_dist
        if s["value"] is not None:
            prev_dist = target["_dist"].get(field)
            if target[field] is None or prev_dist is None or dist < prev_dist:
                target[field] = s["value"]  # closest sample wins
                target["_dist"][field] = dist
        if not target["source_device"] and s["source_device"]:
            target["source_device"] = s["source_device"]
        target["_raw"][s["raw"]["metric"]] = s["raw"]

    # 4. Finalise: drop empty rows, order by time
    out = []
    for ts in sorted(rows):
        row = rows[ts]
        if all(row[f] is None for f in MEASUREMENT_FIELDS):
            continue
        row["raw_json"] = list(row.pop("_raw").values())
        row.pop("_dist")
        out.append(row)

    if stats is not None:
        stats.update(st)
    return out


def poll_once(days_back: int = 10, dry_run: bool = False) -> int:
    """
    Fetch recent body payloads from the Worker, parse them and upsert.
    Returns 0 on success (including "no data yet"), 1 on request/DB error.
    """
    since = (date.today() - timedelta(days=days_back)).isoformat()
    url = f"{HEALTH_WORKER_URL.rstrip('/')}/body"
    headers = {"X-Health-Token": HEALTH_TOKEN}

    try:
        resp = requests.get(url, params={"since": since}, headers=headers, timeout=15)
    except requests.RequestException as e:
        logger.error("Request to Worker failed: %s", e)
        return 1

    if resp.status_code == 404:
        logger.info("No body measurement data available yet (404)")
        return 0

    if resp.status_code != 200:
        logger.error("Worker returned %d: %s", resp.status_code, resp.text[:200])
        return 1

    try:
        payloads = resp.json().get("payloads") or []
    except (ValueError, AttributeError) as e:
        logger.error("Worker returned an invalid body response: %s", e)
        return 1

    if not payloads:
        logger.info("No body payloads since %s", since)
        return 0

    stats: dict = {}
    rows = parse_body_payloads(payloads, stats=stats)
    days = sorted({r["local_day"] for r in rows})

    if dry_run:
        for r in rows:
            logger.info(
                "[dry-run] %s %s weight_kg=%s body_fat_pct=%s",
                r["local_day"], r["measured_at"].strftime("%H:%M:%S%z"),
                r["weight_kg"], r["body_fat_pct"],
            )
    else:
        if rows:
            try:
                conn = get_connection()
                try:
                    insert_body_measurements(conn, rows)
                finally:
                    conn.close()
            except psycopg2.Error as e:
                logger.error("DB error while upserting body measurements: %s", e)
                return 1

    logger.info(
        "Body poll%s: %d payloads, %d rows, %d days (%s..%s), %d warnings, %d outliers dropped",
        " (dry-run)" if dry_run else "",
        len(payloads), len(rows), len(days),
        days[0] if days else "-", days[-1] if days else "-",
        stats.get("warnings", 0), stats.get("outliers", 0),
    )
    return 0


if __name__ == "__main__":
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()
    parser = argparse.ArgumentParser(description="Poll body measurements from the Health Worker")
    parser.add_argument("--dry-run", action="store_true", help="parse and log only; no DB writes")
    parser.add_argument("--days-back", type=int, default=10, help="days of payloads to fetch (default 10)")
    args = parser.parse_args()
    sys.exit(poll_once(days_back=args.days_back, dry_run=args.dry_run))
