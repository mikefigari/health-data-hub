"""
Unit tests for health_data_hub.integrations.apple_health.body_poller.parse_body_payloads.

Pure-function tests: no DB, no network. All values are synthetic.

Run:
    pytest tests/test_body_parser.py -v
"""

from __future__ import annotations

import json
import logging
from datetime import date
from pathlib import Path

import pytest

from health_data_hub.integrations.apple_health.body_poller import parse_body_payloads

FIXTURE = Path(__file__).parent / "fixtures" / "hae_body_sample.json"


def payload(metrics, received_at="2026-10-21T05:00:00.000Z"):
    return {"received_at": received_at, "metrics": metrics}


def metric(name, units, *entries):
    return {
        "name": name,
        "units": units,
        "data": [{"date": d, "qty": q, "source": "Synthetic Scale"} for d, q in entries],
    }


# ---------------------------------------------------------------------------
# Fixture shape
# ---------------------------------------------------------------------------

def test_fixture_parses_to_one_row_per_day():
    body = json.loads(FIXTURE.read_text())
    rows = parse_body_payloads([payload(body["data"]["metrics"])])
    assert [r["local_day"] for r in rows] == [date(2026, 10, 18), date(2026, 10, 19), date(2026, 10, 20)]
    for r in rows:
        assert r["weight_kg"] is not None
        assert r["body_fat_pct"] is not None
        assert r["lean_mass_kg"] is not None
        assert r["bmi"] is not None
        assert r["muscle_mass_kg"] is None
        assert r["water_pct"] is None
        assert r["source"] == "apple_health"
        assert r["source_device"] == "Synthetic Scale"
        assert {e["metric"] for e in r["raw_json"]} == {
            "weight_body_mass", "body_fat_percentage", "lean_body_mass", "body_mass_index",
        }


def test_output_keys():
    rows = parse_body_payloads([payload([metric("weight_body_mass", "kg", ("2026-10-20 07:00:00 -0700", 80))])])
    assert set(rows[0]) == {
        "measured_at", "local_day", "source", "source_device", "weight_kg", "body_fat_pct",
        "lean_mass_kg", "muscle_mass_kg", "water_pct", "bmi", "raw_json",
    }


# ---------------------------------------------------------------------------
# Units
# ---------------------------------------------------------------------------

def test_lb_converted_to_kg():
    rows = parse_body_payloads([payload([
        metric("weight_body_mass", "lb", ("2026-10-20 07:00:00 -0700", 176.37)),
        metric("lean_body_mass", "lbs", ("2026-10-20 07:00:00 -0700", 132.28)),
    ])])
    assert rows[0]["weight_kg"] == round(176.37 * 0.45359237, 2) == 80.0
    assert rows[0]["lean_mass_kg"] == round(132.28 * 0.45359237, 2)


def test_kg_passes_through():
    rows = parse_body_payloads([payload([metric("Weight", "kg", ("2026-10-20 07:00:00 -0700", 81.234))])])
    assert rows[0]["weight_kg"] == 81.23


def test_unknown_weight_unit_skipped(caplog):
    with caplog.at_level(logging.WARNING):
        rows = parse_body_payloads([payload([metric("weight_body_mass", "stone", ("2026-10-20 07:00:00 -0700", 12))])])
    assert rows == []
    assert "unit" in caplog.text


def test_body_fat_fraction_scaled_to_percent():
    rows = parse_body_payloads([payload([
        metric("weight_body_mass", "kg", ("2026-10-20 07:00:00 -0700", 80)),
        metric("body_fat_percentage", "%", ("2026-10-20 07:00:00 -0700", 0.213)),
    ])])
    assert rows[0]["body_fat_pct"] == 21.3


def test_body_fat_percent_unchanged():
    rows = parse_body_payloads([payload([
        metric("weight_body_mass", "kg", ("2026-10-20 07:00:00 -0700", 80)),
        metric("Body Fat Percentage", "%", ("2026-10-20 07:00:00 -0700", 21.34)),
    ])])
    assert rows[0]["body_fat_pct"] == 21.3


# ---------------------------------------------------------------------------
# Merging
# ---------------------------------------------------------------------------

def test_four_series_same_timestamp_merge_into_one_row():
    ts = "2026-10-20 07:00:00 -0700"
    rows = parse_body_payloads([payload([
        metric("weight_body_mass", "kg", (ts, 80)),
        metric("body_fat_percentage", "%", (ts, 20)),
        metric("lean_body_mass", "kg", (ts, 64)),
        metric("body_mass_index", "count", (ts, 24.5)),
    ])])
    assert len(rows) == 1
    r = rows[0]
    assert (r["weight_kg"], r["body_fat_pct"], r["lean_mass_kg"], r["bmi"]) == (80.0, 20.0, 64.0, 24.5)
    assert len(r["raw_json"]) == 4


def test_body_fat_5s_after_weight_merges_2h_later_gets_own_row():
    rows = parse_body_payloads([payload([
        metric("weight_body_mass", "kg", ("2026-10-20 07:00:00 -0700", 80)),
        metric("body_fat_percentage", "%",
               ("2026-10-20 07:00:05 -0700", 20.0),
               ("2026-10-20 09:00:00 -0700", 22.0)),
    ])])
    assert len(rows) == 2
    first, second = rows
    assert first["weight_kg"] == 80.0 and first["body_fat_pct"] == 20.0
    assert first["measured_at"].strftime("%H:%M:%S") == "07:00:00"
    assert second["weight_kg"] is None and second["body_fat_pct"] == 22.0
    assert second["measured_at"].strftime("%H:%M:%S") == "09:00:00"


def test_composition_on_other_day_does_not_merge():
    rows = parse_body_payloads([payload([
        metric("weight_body_mass", "kg", ("2026-10-20 23:59:00 -0700", 80)),
        metric("body_fat_percentage", "%", ("2026-10-21 00:01:00 -0700", 20.0)),
    ])])
    assert len(rows) == 2


# ---------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------

def test_local_day_uses_reported_offset():
    rows = parse_body_payloads([payload([metric("weight_body_mass", "kg", ("2026-10-20 23:30:00 -0700", 80))])])
    assert rows[0]["local_day"] == date(2026, 10, 20)  # 2026-10-21 in UTC


def test_iso_timestamp_fallback():
    rows = parse_body_payloads([payload([metric("weight_body_mass", "kg", ("2026-10-20T07:00:00-07:00", 80))])])
    assert rows[0]["local_day"] == date(2026, 10, 20)


def test_naive_timestamp_rejected(caplog):
    with caplog.at_level(logging.WARNING):
        rows = parse_body_payloads([payload([metric("weight_body_mass", "kg", ("2026-10-20 07:00:00", 80))])])
    assert rows == []
    assert "Naive" in caplog.text


# ---------------------------------------------------------------------------
# Overlapping payloads
# ---------------------------------------------------------------------------

def test_seven_overlapping_payloads_give_one_row_and_latest_wins():
    ts = "2026-10-20 07:00:00 -0700"
    payloads = [
        payload(
            [metric("weight_body_mass", "kg", (ts, 80.0 + i / 10)),
             metric("body_fat_percentage", "%", (ts, 20.0))],
            received_at=f"2026-10-2{i}T05:00:00.000Z",
        )
        for i in range(7)
    ]
    rows = parse_body_payloads(list(reversed(payloads)))  # order must not matter
    assert len(rows) == 1
    assert rows[0]["weight_kg"] == 80.6
    weight_raw = [e for e in rows[0]["raw_json"] if e["metric"] == "weight_body_mass"]
    assert len(weight_raw) == 1
    assert weight_raw[0]["received_at"] == "2026-10-26T05:00:00.000Z"


def test_later_null_does_not_erase_earlier_value():
    ts = "2026-10-20 07:00:00 -0700"
    rows = parse_body_payloads([
        payload([metric("weight_body_mass", "kg", (ts, 80))], received_at="2026-10-20T05:00:00Z"),
        payload([{"name": "weight_body_mass", "units": "kg", "data": [{"date": ts, "qty": None}]}],
                received_at="2026-10-21T05:00:00Z"),
    ])
    assert rows[0]["weight_kg"] == 80.0


# ---------------------------------------------------------------------------
# Unknown metrics, bounds, empty input
# ---------------------------------------------------------------------------

def test_unknown_metric_skipped_with_one_warning(caplog):
    stats = {}
    with caplog.at_level(logging.WARNING):
        rows = parse_body_payloads([
            payload([metric("body_water_percentage", "%", ("2026-10-20 07:00:00 -0700", 55))]),
            payload([metric("body_water_percentage", "%", ("2026-10-20 07:00:00 -0700", 55)),
                     metric("weight_body_mass", "kg", ("2026-10-20 07:00:00 -0700", 80))]),
        ], stats=stats)
    assert len(rows) == 1
    assert rows[0]["water_pct"] is None
    assert caplog.text.count("Skipping unknown body metric") == 1
    assert stats["unknown_metrics"] == 1


def test_out_of_bounds_becomes_none_and_empty_row_dropped():
    stats = {}
    rows = parse_body_payloads([payload([
        metric("weight_body_mass", "kg",
               ("2026-10-19 07:00:00 -0700", 500),    # out of bounds, row has nothing else
               ("2026-10-20 07:00:00 -0700", 80)),
        metric("body_fat_percentage", "%", ("2026-10-20 07:00:00 -0700", 75)),  # out of bounds
    ])], stats=stats)
    assert len(rows) == 1
    assert rows[0]["local_day"] == date(2026, 10, 20)
    assert rows[0]["weight_kg"] == 80.0
    assert rows[0]["body_fat_pct"] is None
    assert stats["outliers"] == 2


def test_empty_input_returns_empty_list():
    assert parse_body_payloads([]) == []
    assert parse_body_payloads([payload([])]) == []
