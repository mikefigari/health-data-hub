"""
Tests for Strava timestamp and utility functions.

All tests are pure logic — no database or API access required.
"""

from datetime import datetime, timezone
import pytest

from health_data_hub.integrations.poll_strava import parse_strava_ts


# ---------------------------------------------------------------------------
# parse_strava_ts
# ---------------------------------------------------------------------------

def test_parses_utc_z_suffix():
    dt = parse_strava_ts("2025-11-17T18:05:32Z")
    assert dt == datetime(2025, 11, 17, 18, 5, 32, tzinfo=timezone.utc)


def test_parses_iso_with_offset():
    dt = parse_strava_ts("2025-11-17T13:05:32-05:00")
    assert dt.utcoffset().total_seconds() == -5 * 3600


def test_returns_none_for_empty_string():
    assert parse_strava_ts("") is None


def test_returns_none_for_none_input():
    assert parse_strava_ts(None) is None


def test_result_is_timezone_aware():
    dt = parse_strava_ts("2025-11-17T18:05:32Z")
    assert dt.tzinfo is not None
