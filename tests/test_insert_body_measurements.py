"""
Unit tests for health_data_hub.etl.load.insert_body_measurements.

FakeConn style (see test_quality.py): no real database.

Run:
    pytest tests/test_insert_body_measurements.py -v
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

from psycopg2.extras import Json

from health_data_hub.etl.load.insert_body_measurements import insert_body_measurements


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def executemany(self, sql, rows):
        self.conn.calls.append((sql, list(rows)))


class FakeConn:
    def __init__(self):
        self.calls = []
        self.commits = 0
        self.cursors_opened = 0

    @contextmanager
    def cursor(self):
        self.cursors_opened += 1
        yield FakeCursor(self)

    def commit(self):
        self.commits += 1


def make_row(**overrides):
    row = {
        "measured_at":    datetime(2026, 10, 20, 7, 0, tzinfo=timezone(timedelta(hours=-7))),
        "local_day":      date(2026, 10, 20),
        "source":         "apple_health",
        "source_device":  "Synthetic Scale",
        "weight_kg":      80.0,
        "body_fat_pct":   20.0,
        "lean_mass_kg":   64.0,
        "muscle_mass_kg": None,
        "water_pct":      None,
        "bmi":            24.5,
        "raw_json":       [{"metric": "weight_body_mass", "units": "kg", "entry": {"qty": 80}, "received_at": "x"}],
    }
    row.update(overrides)
    return row


def test_upsert_sql_and_executemany():
    conn = FakeConn()
    rows = [make_row(), make_row(local_day=date(2026, 10, 21))]
    assert insert_body_measurements(conn, rows) == 2
    assert len(conn.calls) == 1
    sql, params = conn.calls[0]
    assert "INSERT INTO body_measurements" in sql
    assert "ON CONFLICT (source, measured_at)" in sql
    for col in ("source_device", "weight_kg", "body_fat_pct", "lean_mass_kg",
                "muscle_mass_kg", "water_pct", "bmi"):
        assert f"COALESCE(EXCLUDED.{col}," in sql
    assert "raw_json       = EXCLUDED.raw_json" in sql
    assert len(params) == 2


def test_raw_json_wrapped_in_json():
    conn = FakeConn()
    original = make_row()
    insert_body_measurements(conn, [original, make_row(raw_json=None)])
    _, params = conn.calls[0]
    assert isinstance(params[0]["raw_json"], Json)
    assert params[1]["raw_json"] is None
    assert isinstance(original["raw_json"], list)  # input row not mutated


def test_commit_called():
    conn = FakeConn()
    insert_body_measurements(conn, [make_row()])
    assert conn.commits == 1


def test_empty_list_makes_no_db_call():
    conn = FakeConn()
    assert insert_body_measurements(conn, []) == 0
    assert conn.calls == []
    assert conn.cursors_opened == 0
    assert conn.commits == 0
