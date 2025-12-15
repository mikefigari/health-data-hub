"""
Extraction helpers for Oura API responses.
These convert raw JSON into clean Python dicts
that match your Postgres schemas.
"""

from datetime import datetime, timedelta
from typing import List, Dict, Any
from psycopg2.extras import Json





# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_ts(ts: str | None):
    """Return a proper datetime or None."""
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Sleep Extraction
# ---------------------------------------------------------------------------

def extract_sleep_records(sleep_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Convert a full Oura sleep JSON payload into a list of row dicts
    for insertion into oura_sleep_raw.
    """
    results = []

    for row in sleep_json.get("data", []):
        results.append({
            "sleep_id": row.get("id"),
            "day": row.get("day"),

            "bedtime_start": _parse_ts(row.get("bedtime_start")),
            "bedtime_end": _parse_ts(row.get("bedtime_end")),

            "total_sleep_sec": row.get("total_sleep_duration"),
            "time_in_bed_sec": row.get("time_in_bed"),
            "deep_sleep_sec": row.get("deep_sleep_duration"),
            "light_sleep_sec": row.get("light_sleep_duration"),
            "rem_sleep_sec": row.get("rem_sleep_duration"),
            "awake_sec": row.get("awake_time"),

            "efficiency": row.get("efficiency"),
            "latency_sec": row.get("latency"),
            "restless_periods": row.get("restless_periods"),

            "lowest_hr": row.get("lowest_heart_rate"),
            "avg_hr": row.get("average_heart_rate"),
            "avg_hrv": row.get("average_hrv"),
            "avg_breath": row.get("average_breath"),

            "sleep_phase_5_min": row.get("sleep_phase_5_min"),
            
            "raw_json": row


        })

    return results


# ---------------------------------------------------------------------------
# Readiness Extraction
# ---------------------------------------------------------------------------

def extract_readiness_records(sleep_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Readiness is embedded inside each sleep record.
    We convert each day's readiness into one readiness row.
    """
    results = []

    for row in sleep_json.get("data", []):
        r = row.get("readiness")
        if not r:
            continue

        contributors = r.get("contributors", {}) or {}

        results.append({
            "day": row.get("day"),  # readiness keyed by the sleep day

            "score": r.get("score"),
            "temp_dev": r.get("temperature_deviation"),
            "temp_trend_dev": r.get("temperature_trend_deviation"),

            "r_activity_balance": contributors.get("activity_balance"),
            "r_body_temp": contributors.get("body_temperature"),
            "r_hrv_balance": contributors.get("hrv_balance"),
            "r_prev_day_activity": contributors.get("previous_day_activity"),
            "r_prev_night": contributors.get("previous_night"),
            "r_recovery_index": contributors.get("recovery_index"),
            "r_resting_hr": contributors.get("resting_heart_rate"),
            "r_sleep_balance": contributors.get("sleep_balance"),

            "raw_json": row

        })

    return results


# ---------------------------------------------------------------------------
# HR Samples Extraction (HR + HRV)
# ---------------------------------------------------------------------------

def extract_hr_samples(sleep_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Build timestamped HR + HRV samples from each sleep record.
    Oura gives 5-min intervals (typically interval = 300 seconds).
    """
    results = []

    for row in sleep_json.get("data", []):
        sleep_id = row.get("id")

        hr_block = row.get("heart_rate") or {}
        hrv_block = row.get("hrv") or {}

        hr_items = hr_block.get("items", [])
        hrv_items = hrv_block.get("items", [])

        start_ts_hr = _parse_ts(hr_block.get("timestamp"))
        start_ts_hrv = _parse_ts(hrv_block.get("timestamp"))

        interval_sec_hr = hr_block.get("interval") or 300
        interval_sec_hrv = hrv_block.get("interval") or 300

        # HR samples
        if start_ts_hr and hr_items:
            for idx, value in enumerate(hr_items):
                ts = start_ts_hr + timedelta(seconds=interval_sec_hr * idx)
                results.append({
                    "sleep_id": sleep_id,
                    "timestamp": ts,
                    "bpm": float(value) if value is not None else None,
                    "hrv_rmssd": None,
                    "source": "sleep",
                    "raw_json": {
                        "type": "hr",
                        "value": value
                    }
                })

        # HRV samples
        if start_ts_hrv and hrv_items:
            for idx, value in enumerate(hrv_items):
                ts = start_ts_hrv + timedelta(seconds=interval_sec_hrv * idx)
                results.append({
                    "sleep_id": sleep_id,
                    "timestamp": ts,
                    "bpm": None,
                    "hrv_rmssd": float(value) if value is not None else None,
                    "source": "sleep",
                    "raw_json": {
                        "type": "hrv",
                        "value": value
                    }
                })

    return results


# ---------------------------------------------------------------------------
# Activity Extraction (placeholder — needs activity JSON)
# ---------------------------------------------------------------------------

def extract_activity_records(activity_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Placeholder — will fill when you fetch actual activity payload.
    """
    results = []

    for row in activity_json.get("data", []):
        results.append({
            "activity_id": row.get("id"),
            "day": row.get("day"),

            "steps": row.get("steps"),
            "cal_total": row.get("cal_total") or row.get("total_calories"),
            "cal_active": row.get("cal_active") or row.get("active_calories"),

            "inactive_sec": row.get("inactive_time"),
            "low_activity_sec": row.get("low_activity_time"),
            "medium_activity_sec": row.get("medium_activity_time"),
            "high_activity_sec": row.get("high_activity_time"),

            "met_min_low": row.get("met_min_low"),
            "met_min_medium": row.get("met_min_medium"),
            "met_min_high": row.get("met_min_high"),

            "raw_json": row

        })

    return results
