"""
Tests for the body_measurements FreshnessCheck registered in
health_data_hub.quality.checks_health. FakeConn style (see test_quality.py).

Run:
    pytest tests/test_body_freshness.py -v
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from health_data_hub.quality.checks import FreshnessCheck
from health_data_hub.quality.checks_health import build_runner


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


def body_check(source="all"):
    checks = [c for c in build_runner(source=source).checks
              if isinstance(c, FreshnessCheck) and c.table == "body_measurements"]
    assert len(checks) == 1, f"expected one body_measurements FreshnessCheck for source={source}"
    return checks[0]


def test_registered_for_all_and_body_sources():
    assert body_check("all").severity == "warn"
    assert body_check("body").check_name == "freshness_body_measurements"


def test_uses_max_local_day_and_three_day_window():
    check = body_check()
    assert check.timestamp_column.startswith("local_day")
    assert check.max_age_minutes == 3 * 24 * 60
    conn = FakeConn((datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1),))
    check.run(conn)
    assert "MAX(local_day" in conn.executed[0]
    assert "FROM body_measurements" in conn.executed[0]


def test_passes_when_recent():
    yesterday = datetime.combine(datetime.now(timezone.utc).replace(tzinfo=None).date() - timedelta(days=1), datetime.min.time())
    assert body_check().run(FakeConn((yesterday,))).passed


def test_warns_when_older_than_three_days():
    old = datetime.combine(datetime.now(timezone.utc).replace(tzinfo=None).date() - timedelta(days=5), datetime.min.time())
    result = body_check().run(FakeConn((old,)))
    assert not result.passed
    assert result.severity == "warn"


def test_warns_when_table_empty():
    result = body_check().run(FakeConn((None,)))
    assert not result.passed
    assert "no rows" in result.message
