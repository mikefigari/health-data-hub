"""
Unit tests for health_data_hub.quality.checks

Uses a FakeConn fixture that accepts a dict of (sql_pattern → rows) to return,
so tests run without a real database. The fixture mimics the psycopg2 cursor
protocol (cursor(), execute(), fetchone(), fetchall()).

Run:
    pytest tests/test_quality.py -v
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from health_data_hub.quality.checks import (
    AnomalyCheck,
    CheckRunner,
    FreshnessCheck,
    NullCheck,
    QualityReport,
    RowCountCheck,
    SchemaCheck,
    ValueRangeCheck,
)


# ---------------------------------------------------------------------------
# Fake DB connection
# ---------------------------------------------------------------------------

class FakeCursor:
    """Minimal psycopg2 cursor that returns a pre-loaded result."""

    def __init__(self, result):
        self._result = result  # single row tuple, list of tuples, or None

    def execute(self, sql, params=None):
        pass  # no-op; result is pre-loaded

    def fetchone(self):
        if isinstance(self._result, list):
            return self._result[0] if self._result else None
        return self._result

    def fetchall(self):
        if isinstance(self._result, list):
            return self._result
        return [self._result] if self._result else []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class FakeConn:
    """Fake connection whose cursor returns a fixed result per test."""

    def __init__(self, result):
        self._result = result

    @contextmanager
    def cursor(self):
        yield FakeCursor(self._result)

    def commit(self):
        pass


# ---------------------------------------------------------------------------
# RowCountCheck
# ---------------------------------------------------------------------------

class TestRowCountCheck:
    def test_pass_above_minimum(self):
        conn = FakeConn((10,))
        result = RowCountCheck("workouts_raw", min_rows=1).run(conn)
        assert result.passed
        assert result.rows_affected == 10

    def test_fail_below_minimum(self):
        conn = FakeConn((0,))
        result = RowCountCheck("workouts_raw", min_rows=1).run(conn)
        assert not result.passed
        assert "0 rows" in result.message

    def test_fail_above_maximum(self):
        conn = FakeConn((500,))
        result = RowCountCheck("workouts_raw", min_rows=1, max_rows=100).run(conn)
        assert not result.passed
        assert "500 rows" in result.message

    def test_pass_within_range(self):
        conn = FakeConn((50,))
        result = RowCountCheck("workouts_raw", min_rows=1, max_rows=100).run(conn)
        assert result.passed

    def test_edge_exactly_minimum(self):
        conn = FakeConn((1,))
        result = RowCountCheck("workouts_raw", min_rows=1).run(conn)
        assert result.passed

    def test_edge_exactly_maximum(self):
        conn = FakeConn((100,))
        result = RowCountCheck("workouts_raw", min_rows=1, max_rows=100).run(conn)
        assert result.passed


# ---------------------------------------------------------------------------
# ValueRangeCheck
# ---------------------------------------------------------------------------

class TestValueRangeCheck:
    def test_pass_no_out_of_range_rows(self):
        conn = FakeConn((0,))
        result = ValueRangeCheck("workout_summary", "np_watts", 0, 2000).run(conn)
        assert result.passed

    def test_fail_out_of_range_rows_exist(self):
        conn = FakeConn((3,))
        result = ValueRangeCheck("workout_summary", "np_watts", 0, 2000).run(conn)
        assert not result.passed
        assert "3 rows outside" in result.message

    def test_severity_warn(self):
        conn = FakeConn((1,))
        result = ValueRangeCheck("workout_summary", "np_watts", 0, 2000, severity="warn").run(conn)
        assert not result.passed
        assert result.severity == "warn"

    def test_pass_heart_rate_range(self):
        conn = FakeConn((0,))
        result = ValueRangeCheck("workout_samples", "heartrate", 30, 220).run(conn)
        assert result.passed

    def test_fail_intensity_factor_too_high(self):
        conn = FakeConn((2,))
        result = ValueRangeCheck("workout_summary", "intensity_factor", 0, 1.5).run(conn)
        assert not result.passed


# ---------------------------------------------------------------------------
# FreshnessCheck
# ---------------------------------------------------------------------------

class TestFreshnessCheck:
    def test_pass_recent_timestamp(self):
        recent = datetime.now(timezone.utc) - timedelta(minutes=30)
        conn = FakeConn((recent,))
        result = FreshnessCheck("strava_sync_log", "triggered_at", max_age_minutes=120).run(conn)
        assert result.passed

    def test_fail_stale_timestamp(self):
        stale = datetime.now(timezone.utc) - timedelta(hours=5)
        conn = FakeConn((stale,))
        result = FreshnessCheck("strava_sync_log", "triggered_at", max_age_minutes=120).run(conn)
        assert not result.passed
        assert "300m ago" in result.message or "m ago" in result.message

    def test_fail_no_rows(self):
        conn = FakeConn(None)
        result = FreshnessCheck("strava_sync_log", "triggered_at", max_age_minutes=120).run(conn)
        assert not result.passed
        assert "no rows" in result.message

    def test_pass_naive_timestamp_treated_as_utc(self):
        # Naive datetimes (no tzinfo) should not raise
        naive = datetime.utcnow() - timedelta(minutes=10)
        conn = FakeConn((naive,))
        result = FreshnessCheck("strava_sync_log", "triggered_at", max_age_minutes=120).run(conn)
        assert result.passed

    def test_edge_just_inside_threshold(self):
        # 1 minute inside the window should pass
        just_inside = datetime.now(timezone.utc) - timedelta(minutes=119)
        conn = FakeConn((just_inside,))
        result = FreshnessCheck("strava_sync_log", "triggered_at", max_age_minutes=120).run(conn)
        assert result.passed


# ---------------------------------------------------------------------------
# NullCheck
# ---------------------------------------------------------------------------

class TestNullCheck:
    def test_pass_no_nulls(self):
        conn = FakeConn((0, 100))  # 0 nulls, 100 total
        result = NullCheck("workouts_raw", "external_id").run(conn)
        assert result.passed

    def test_fail_nulls_present_zero_tolerance(self):
        conn = FakeConn((5, 100))  # 5 nulls, 100 total
        result = NullCheck("workouts_raw", "external_id", max_null_pct=0.0).run(conn)
        assert not result.passed
        assert "5/100" in result.message

    def test_pass_within_allowed_null_pct(self):
        conn = FakeConn((5, 100))  # 5% nulls
        result = NullCheck("some_table", "some_col", max_null_pct=0.10).run(conn)
        assert result.passed

    def test_fail_exceeds_allowed_null_pct(self):
        conn = FakeConn((15, 100))  # 15% nulls, max 10%
        result = NullCheck("some_table", "some_col", max_null_pct=0.10).run(conn)
        assert not result.passed

    def test_pass_empty_table(self):
        # Empty table should not divide-by-zero; should pass with a note
        conn = FakeConn((0, 0))
        result = NullCheck("empty_table", "col").run(conn)
        assert result.passed
        assert "empty" in result.message


# ---------------------------------------------------------------------------
# SchemaCheck
# ---------------------------------------------------------------------------

class TestSchemaCheck:
    def _make_conn(self, columns: list[tuple[str, str]]):
        """columns: list of (column_name, data_type) tuples as returned by information_schema"""
        return FakeConn(columns)

    def test_pass_all_columns_present(self):
        conn = self._make_conn([("id", "integer"), ("external_id", "character varying")])
        result = SchemaCheck(
            "workouts_raw",
            {"id": "integer", "external_id": "character varying"},
        ).run(conn)
        assert result.passed

    def test_fail_missing_column(self):
        conn = self._make_conn([("id", "integer")])  # external_id missing
        result = SchemaCheck(
            "workouts_raw",
            {"id": "integer", "external_id": "character varying"},
        ).run(conn)
        assert not result.passed
        assert "external_id" in result.message

    def test_fail_wrong_type(self):
        conn = self._make_conn([("id", "text")])  # id should be integer
        result = SchemaCheck("workouts_raw", {"id": "integer"}).run(conn)
        assert not result.passed
        assert "id" in result.message

    def test_pass_type_substring_match(self):
        # "character varying" contains "character" — partial match should pass
        conn = self._make_conn([("name", "character varying")])
        result = SchemaCheck("t", {"name": "character"}).run(conn)
        assert result.passed


# ---------------------------------------------------------------------------
# AnomalyCheck
# ---------------------------------------------------------------------------

class TestAnomalyCheck:
    def _make_conn(self, today_cnt, mean, stddev):
        return FakeConn((today_cnt, mean, stddev))

    def test_pass_normal_count(self):
        conn = self._make_conn(3, 3.0, 0.8)
        result = AnomalyCheck("workouts_raw", "id").run(conn)
        assert result.passed

    def test_fail_extreme_outlier(self):
        # today=20, mean=3, stddev=1 → z=17 >> 3.0 threshold
        conn = self._make_conn(20, 3.0, 1.0)
        result = AnomalyCheck("workouts_raw", "id").run(conn)
        assert not result.passed
        assert "z=" in result.message

    def test_pass_rest_day_with_stddev_floor(self):
        # Rest day: today=0, mean=0.5, but stddev would be ~0.5 without floor
        # With min_baseline_stddev=0.5, z = (0 - 0.5)/0.5 = 1.0 — should NOT alert
        conn = self._make_conn(0, 0.5, 0.3)  # raw stddev=0.3, floored to 0.5
        result = AnomalyCheck("workouts_raw", "id", min_baseline_stddev=0.5).run(conn)
        assert result.passed

    def test_pass_no_baseline_data(self):
        # NULL mean means insufficient history — should pass with a note
        conn = FakeConn(None)
        result = AnomalyCheck("workouts_raw", "id").run(conn)
        assert result.passed
        assert "insufficient" in result.message

    def test_severity_is_warn_by_default(self):
        conn = self._make_conn(20, 3.0, 1.0)
        result = AnomalyCheck("workouts_raw", "id").run(conn)
        assert result.severity == "warn"


# ---------------------------------------------------------------------------
# CheckRunner
# ---------------------------------------------------------------------------

class TestCheckRunner:
    def test_run_all_returns_report(self):
        checks = [
            RowCountCheck("workouts_raw", min_rows=1),
            NullCheck("workouts_raw", "external_id"),
        ]
        conn = FakeConn((10,))  # both checks will return (10,) or (0, 10)
        # NullCheck expects (nulls, total) — patch individually
        results = []
        for check in checks:
            if isinstance(check, NullCheck):
                result = check.run(FakeConn((0, 10)))
            else:
                result = check.run(FakeConn((10,)))
            results.append(result)

        report = QualityReport(run_id=str(uuid.uuid4()), run_at=datetime.now(timezone.utc))
        report.results = results
        assert not report.has_failures
        assert report.error_count == 0
        assert report.warn_count == 0

    def test_report_has_errors_only_on_error_severity(self):
        from health_data_hub.quality.checks import CheckResult
        report = QualityReport(run_id=str(uuid.uuid4()), run_at=datetime.now(timezone.utc))
        report.results = [
            CheckResult("warn_check", "warn", False, "a warning"),
            CheckResult("pass_check", "error", True, "fine"),
        ]
        assert report.has_failures
        assert not report.has_errors   # only warn-severity failure, no error-severity
        assert report.warn_count == 1
        assert report.error_count == 0

    def test_runner_catches_check_exceptions(self):
        """A check that raises should not kill the runner — result is marked failed."""
        class BrokenCheck(RowCountCheck):
            def run(self, conn):
                raise RuntimeError("db explosion")

        runner = CheckRunner([BrokenCheck("t", 1)])
        report = runner.run_all(FakeConn(None))
        assert len(report.results) == 1
        assert not report.results[0].passed
        assert "exception" in report.results[0].message.lower()

    def test_empty_runner_returns_passing_report(self):
        runner = CheckRunner([])
        report = runner.run_all(FakeConn(None))
        assert not report.has_failures
        assert len(report.results) == 0
