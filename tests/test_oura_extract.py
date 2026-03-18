"""
Tests for Oura API response extraction.

All tests are pure logic — no database or API access required.
The extraction functions transform raw JSON dicts into row dicts
ready for DB insertion.
"""

from datetime import datetime, timezone
import pytest

from health_data_hub.etl.extract.oura_extract import (
    extract_sleep_records,
    extract_readiness_records,
    extract_hr_samples,
    extract_activity_records,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_SLEEP_ROW = {
    "id": "sleep-abc123",
    "day": "2025-03-01",
    "bedtime_start": "2025-03-01T22:30:00+00:00",
    "bedtime_end": "2025-03-02T06:30:00+00:00",
    "total_sleep_duration": 27000,
    "time_in_bed": 28800,
    "deep_sleep_duration": 5400,
    "light_sleep_duration": 12600,
    "rem_sleep_duration": 9000,
    "awake_time": 1800,
    "efficiency": 94,
    "latency": 420,
    "restless_periods": 3,
    "lowest_heart_rate": 48,
    "average_heart_rate": 55.2,
    "average_hrv": 62.4,
    "average_breath": 14.1,
    "sleep_phase_5_min": "444432221112222333",
    "readiness": {
        "score": 82,
        "temperature_deviation": 0.1,
        "temperature_trend_deviation": -0.05,
        "contributors": {
            "activity_balance": 85,
            "body_temperature": 90,
            "hrv_balance": 78,
            "previous_day_activity": 80,
            "previous_night": 75,
            "recovery_index": 88,
            "resting_heart_rate": 84,
            "sleep_balance": 79,
        },
    },
    "heart_rate": {
        "timestamp": "2025-03-01T22:30:00+00:00",
        "interval": 300,
        "items": [55, 53, 51, 50, 49],
    },
    "hrv": {
        "timestamp": "2025-03-01T22:35:00+00:00",
        "interval": 300,
        "items": [60, 65, 70, 68, 72],
    },
}

SAMPLE_ACTIVITY_ROW = {
    "id": "activity-xyz789",
    "day": "2025-03-01",
    "steps": 8500,
    "cal_total": 2200,
    "active_calories": 450,
    "inactive_time": 28800,
    "low_activity_time": 5400,
    "medium_activity_time": 1800,
    "high_activity_time": 600,
    "low_activity_met_minutes": 120,
    "medium_activity_met_minutes": 90,
    "high_activity_met_minutes": 60,
}


def _make_payload(*rows):
    return {"data": list(rows)}


# ---------------------------------------------------------------------------
# extract_sleep_records
# ---------------------------------------------------------------------------

def test_sleep_empty_payload():
    assert extract_sleep_records({"data": []}) == []


def test_sleep_extracts_one_record():
    rows = extract_sleep_records(_make_payload(SAMPLE_SLEEP_ROW))
    assert len(rows) == 1


def test_sleep_field_mapping():
    row = extract_sleep_records(_make_payload(SAMPLE_SLEEP_ROW))[0]
    assert row["sleep_id"] == "sleep-abc123"
    assert row["day"] == "2025-03-01"
    assert row["total_sleep_sec"] == 27000
    assert row["efficiency"] == 94
    assert row["avg_hrv"] == 62.4
    assert row["lowest_hr"] == 48


def test_sleep_bedtime_parsed_as_datetime():
    row = extract_sleep_records(_make_payload(SAMPLE_SLEEP_ROW))[0]
    assert isinstance(row["bedtime_start"], datetime)
    assert isinstance(row["bedtime_end"], datetime)


def test_sleep_raw_json_is_full_row():
    row = extract_sleep_records(_make_payload(SAMPLE_SLEEP_ROW))[0]
    assert row["raw_json"] == SAMPLE_SLEEP_ROW


# ---------------------------------------------------------------------------
# extract_readiness_records
# ---------------------------------------------------------------------------

def test_readiness_empty_payload():
    assert extract_readiness_records({"data": []}) == []


def test_readiness_skips_rows_without_readiness():
    row_no_readiness = {**SAMPLE_SLEEP_ROW, "readiness": None}
    assert extract_readiness_records(_make_payload(row_no_readiness)) == []


def test_readiness_extracts_score_and_contributors():
    rows = extract_readiness_records(_make_payload(SAMPLE_SLEEP_ROW))
    assert len(rows) == 1
    r = rows[0]
    assert r["score"] == 82
    assert r["r_hrv_balance"] == 78
    assert r["r_resting_hr"] == 84
    assert r["r_sleep_balance"] == 79
    assert r["day"] == "2025-03-01"


def test_readiness_temp_deviations():
    row = extract_readiness_records(_make_payload(SAMPLE_SLEEP_ROW))[0]
    assert row["temp_dev"] == 0.1
    assert row["temp_trend_dev"] == -0.05


# ---------------------------------------------------------------------------
# extract_hr_samples
# ---------------------------------------------------------------------------

def test_hr_samples_empty_payload():
    assert extract_hr_samples({"data": []}) == []


def test_hr_samples_count():
    # 5 HR items + 5 HRV items = 10 rows
    rows = extract_hr_samples(_make_payload(SAMPLE_SLEEP_ROW))
    assert len(rows) == 10


def test_hr_samples_bpm_rows():
    rows = extract_hr_samples(_make_payload(SAMPLE_SLEEP_ROW))
    hr_rows = [r for r in rows if r["bpm"] is not None]
    assert len(hr_rows) == 5
    assert hr_rows[0]["bpm"] == 55.0
    assert hr_rows[0]["hrv_rmssd"] is None
    assert hr_rows[0]["source"] == "sleep"


def test_hrv_samples_rows():
    rows = extract_hr_samples(_make_payload(SAMPLE_SLEEP_ROW))
    hrv_rows = [r for r in rows if r["hrv_rmssd"] is not None]
    assert len(hrv_rows) == 5
    assert hrv_rows[0]["hrv_rmssd"] == 60.0
    assert hrv_rows[0]["bpm"] is None


def test_hr_samples_timestamps_spaced_by_interval():
    rows = extract_hr_samples(_make_payload(SAMPLE_SLEEP_ROW))
    hr_rows = [r for r in rows if r["bpm"] is not None]
    delta = (hr_rows[1]["timestamp"] - hr_rows[0]["timestamp"]).seconds
    assert delta == 300  # 5-minute interval


def test_hr_samples_sleep_id_set():
    rows = extract_hr_samples(_make_payload(SAMPLE_SLEEP_ROW))
    for r in rows:
        assert r["sleep_id"] == "sleep-abc123"


def test_hr_samples_none_value_handled():
    """A None value in the items list should produce a row with bpm=None (not crash)."""
    row = {
        "id": "sleep-test",
        "heart_rate": {
            "timestamp": "2025-03-01T22:30:00+00:00",
            "interval": 300,
            "items": [55, None, 53],
        },
        "hrv": {},  # no HRV to keep this simple
    }
    rows = extract_hr_samples({"data": [row]})
    assert len(rows) == 3
    assert None in [r["bpm"] for r in rows]


# ---------------------------------------------------------------------------
# extract_activity_records
# ---------------------------------------------------------------------------

def test_activity_empty_payload():
    assert extract_activity_records({"data": []}) == []


def test_activity_field_mapping():
    rows = extract_activity_records(_make_payload(SAMPLE_ACTIVITY_ROW))
    assert len(rows) == 1
    r = rows[0]
    assert r["activity_id"] == "activity-xyz789"
    assert r["day"] == "2025-03-01"
    assert r["steps"] == 8500
    assert r["cal_active"] == 450
    assert r["high_activity_sec"] == 600
    assert r["met_min_high"] == 60


def test_activity_raw_json_preserved():
    rows = extract_activity_records(_make_payload(SAMPLE_ACTIVITY_ROW))
    assert rows[0]["raw_json"] == SAMPLE_ACTIVITY_ROW


def test_activity_cal_total_fallback():
    """cal_total falls back to total_calories key if cal_total is absent."""
    row = {**SAMPLE_ACTIVITY_ROW}
    del row["cal_total"]
    row["total_calories"] = 9999
    rows = extract_activity_records(_make_payload(row))
    assert rows[0]["cal_total"] == 9999
