"""
Tests for _nutrition_checks() in health_data_hub.quality.checks_health:
nutrition quality checks follow food_log. FakeConn style (see test_body_freshness.py).

Run:
    pytest tests/test_nutrition_checks.py -v
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from health_data_hub.quality.checks import FreshnessCheck, ValueRangeCheck
from health_data_hub.quality.checks_health import _nutrition_checks


class FakeCursor:
    def __init__(self, result, executed):
        self._result = result
        self._executed = executed

    def execute(self, sql, params=None):
        self._executed.append(sql)

    def fetchone(self):
        return self._result

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class FakeConn:
    def __init__(self, result):
        self._result = result
        self.executed = []

    @contextmanager
    def cursor(self):
        yield FakeCursor(self._result, self.executed)


def freshness_checks(table):
    return [c for c in _nutrition_checks()
            if isinstance(c, FreshnessCheck) and c.table == table]


def test_freshness_on_food_log_created_at():
    checks = freshness_checks("food_log")
    assert len(checks) == 1
    check = checks[0]
    assert check.timestamp_column == "created_at"
    assert check.max_age_minutes == 1440
    assert check.severity == "warn"
    assert check.check_name == "freshness_food_log"


def test_no_freshness_on_nutrition_daily():
    assert freshness_checks("nutrition_daily") == []


def test_calories_range_on_food_log_daily():
    matches = [c for c in _nutrition_checks()
               if isinstance(c, ValueRangeCheck)
               and c.table == "food_log_daily" and c.column == "calories"]
    assert len(matches) == 1
    assert matches[0].min_val == 0
    assert matches[0].max_val == 8000


def test_freshness_fails_when_25h_old():
    check = freshness_checks("food_log")[0]
    old = datetime.now(timezone.utc) - timedelta(hours=25)
    result = check.run(FakeConn((old,)))
    assert not result.passed
    assert result.severity == "warn"


def test_freshness_passes_when_recent():
    check = freshness_checks("food_log")[0]
    recent = datetime.now(timezone.utc) - timedelta(hours=1)
    assert check.run(FakeConn((recent,))).passed
