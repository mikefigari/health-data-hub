"""
Apple Health webhook receiver.

Accepts POST requests from the Health Auto Export iOS app and upserts
daily nutrition data into the nutrition_daily PostgreSQL table.

Health Auto Export sends a JSON payload containing an array of metrics.
Each metric has a 'name', 'units', and 'data' array of {date, qty} objects.

Expected metric names (Health Auto Export uses Apple Health identifiers):
    dietary_energy_consumed   — kcal or kJ (check units field)
    dietary_protein           — g
    dietary_carbohydrates     — g
    dietary_fat_total         — g

Usage (standalone):
    python -m health_data_hub.integrations.apple_health.health_webhook_receiver

Or run directly:
    python health_data_hub/integrations/apple_health/health_webhook_receiver.py

Test with curl:
    curl -X POST http://localhost:8765/health \\
         -H "Content-Type: application/json" \\
         -d '{"data":{"metrics":[{"name":"dietary_energy_consumed","units":"kcal","data":[{"date":"2026-03-24 00:00:00 -0700","qty":2100}]}]}}'
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

from health_data_hub.utils.db_connect import get_connection
from health_data_hub.etl.load.insert_nutrition_daily import insert_nutrition_daily

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[4]

PORT = 8765

# Map from Health Auto Export metric names to internal keys.
# Health Auto Export may use either snake_case or camelCase depending on version.
_METRIC_MAP: dict[str, str] = {
    "dietary_energy_consumed":  "calories",
    "dietaryenergyconsumed":    "calories",
    "active_energy":            "calories",  # fallback
    "energy":                   "calories",  # Cronometer
    "dietary_energy":           "calories",  # Cronometer
    "dietary_protein":          "protein_g",
    "dietaryprotein":           "protein_g",
    "protein":                  "protein_g",  # Cronometer
    "dietary_carbohydrates":    "carbs_g",
    "dietarycarbohydrates":     "carbs_g",
    "carbohydrates":            "carbs_g",   # Cronometer
    "dietary_fat_total":        "fat_g",
    "dietaryfattotal":          "fat_g",
    "total_fat":                "fat_g",     # Cronometer
    "dietary_fiber":            "fiber_g",
    "dietaryfiber":             "fiber_g",
    "fiber":                    "fiber_g",   # Cronometer
}


def _parse_date(date_str: str) -> str | None:
    """
    Extract YYYY-MM-DD from Health Auto Export date strings.
    Input formats seen: '2026-03-24 00:00:00 -0700', '2026-03-24T00:00:00-07:00'
    Returns None if unparseable.
    """
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d"):
        try:
            return datetime.strptime(date_str.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    # Last resort: take the first 10 characters if they look like a date
    if len(date_str) >= 10 and date_str[4] == "-" and date_str[7] == "-":
        return date_str[:10]
    return None


def _extract_nutrition(payload: dict) -> dict[str, dict]:
    """
    Parse Health Auto Export JSON payload into a dict keyed by YYYY-MM-DD date.

    Supports both payload shapes emitted by Health Auto Export:
      Shape A: {"data": {"metrics": [...]}}
      Shape B: {"metrics": [...]}

    Returns {date_str: {calories, protein_g, carbs_g, fat_g, fiber_g, units_note}}.
    """
    metrics = (
        payload.get("data", {}).get("metrics")
        or payload.get("metrics")
        or []
    )

    # day_str → {internal_key → float}
    by_day: dict[str, dict] = {}

    for metric in metrics:
        raw_name: str = (metric.get("name") or "").lower().replace("-", "_").replace(" ", "_")
        internal_key = _METRIC_MAP.get(raw_name)
        if not internal_key:
            logger.info("Unrecognised metric name %r — not in _METRIC_MAP, skipping", raw_name)
            continue

        units: str = (metric.get("units") or "").lower()
        data_points = metric.get("data") or []

        for point in data_points:
            raw_date = point.get("date") or point.get("startDate") or ""
            qty = point.get("qty")
            if qty is None or raw_date == "":
                continue

            date_str = _parse_date(str(raw_date))
            if not date_str:
                logger.warning("Could not parse date %r — skipping point", raw_date)
                continue

            try:
                qty = float(qty)
            except (TypeError, ValueError):
                logger.warning("Non-numeric qty %r for %s on %s — skipping", qty, raw_name, date_str)
                continue

            # Convert kJ → kcal if energy is reported in kJ
            if internal_key == "calories" and "kj" in units:
                qty = round(qty / 4.184)

            day = by_day.setdefault(date_str, {})
            # Sum across multiple entries for the same day/metric (e.g. per-meal records)
            day[internal_key] = day.get(internal_key, 0.0) + qty

    return by_day


def process_payload(payload: dict) -> list[str]:
    """
    Parse payload and upsert one row per day into nutrition_daily.
    Returns list of date strings upserted.
    """
    by_day = _extract_nutrition(payload)

    if not by_day:
        logger.warning("No recognised nutrition metrics found in payload")
        return []

    now_utc = datetime.now(timezone.utc)
    rows = []
    for date_str, nutrients in by_day.items():
        rows.append({
            "day":            date.fromisoformat(date_str),
            "calories":       round(nutrients["calories"]) if nutrients.get("calories") is not None else None,
            "protein_g":      round(nutrients["protein_g"], 1) if nutrients.get("protein_g") is not None else None,
            "carbs_g":        round(nutrients["carbs_g"], 1) if nutrients.get("carbs_g") is not None else None,
            "fat_g":          round(nutrients["fat_g"], 1) if nutrients.get("fat_g") is not None else None,
            "fiber_g":        round(nutrients["fiber_g"], 1) if nutrients.get("fiber_g") is not None else None,
            "sugar_g":        None,
            "sodium_mg":      None,
            "goal_calories":  None,
            "goal_protein_g": None,
            "goal_carbs_g":   None,
            "goal_fat_g":     None,
            "meals_json":     None,
            "source":         "apple_health",
            "logged_complete": None,
            "weight_kg":      None,
            "created_at":     now_utc,
            "updated_at":     now_utc,
        })

    conn = get_connection()
    try:
        upserted = insert_nutrition_daily(conn, rows)
    finally:
        conn.close()

    written = [r["day"].isoformat() for r in rows]
    logger.info("Upserted %d nutrition rows into DB: %s", upserted, written)
    return written


class _HealthWebhookHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.debug("HTTP %s", format % args)

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        logger.info("POST %s from %s", self.path, self.client_address[0])
        if path != "/health":
            logger.warning("404 — unexpected path %r (full: %r)", path, self.path)
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self._respond(400, {"error": "Empty body"})
            return

        try:
            body = self.rfile.read(length)
            payload = json.loads(body)
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("Invalid JSON from %s: %s", self.client_address, e)
            self._respond(400, {"error": f"Invalid JSON: {e}"})
            return

        try:
            written = process_payload(payload)
        except Exception as e:
            logger.error("Failed to process payload: %s", e, exc_info=True)
            self._respond(500, {"error": "Internal error processing payload"})
            return

        if written:
            self._respond(200, {"status": "ok", "dates_written": written})
        else:
            self._respond(200, {"status": "ok", "dates_written": [], "note": "No recognised nutrition metrics"})

    def _respond(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run_server(port: int = PORT) -> None:
    server = HTTPServer(("", port), _HealthWebhookHandler)
    logger.info("Apple Health webhook receiver listening on port %d", port)
    logger.info("Endpoint: POST http://localhost:%d/health", port)
    try:
        server.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Webhook receiver stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()
    run_server()
