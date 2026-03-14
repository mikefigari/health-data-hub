"""
Tests for NP, IF, and TSS computation.

All tests are pure logic — no database or API access required.
"""

import pytest
from health_data_hub.etl.transform.build_workout_summary import _compute_np_if_tss


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

def test_empty_series_returns_all_none():
    assert _compute_np_if_tss([], 250.0, 3600) == (None, None, None)


def test_series_shorter_than_30_returns_all_none():
    # Rolling 30-second average requires at least 30 data points
    assert _compute_np_if_tss([200.0] * 29, 250.0, 1800) == (None, None, None)


def test_none_ftp_returns_np_only():
    watts = [200.0] * 100
    np_val, if_val, tss = _compute_np_if_tss(watts, None, 100)
    assert np_val is not None
    assert if_val is None
    assert tss is None


def test_zero_ftp_returns_np_only():
    watts = [200.0] * 100
    np_val, if_val, tss = _compute_np_if_tss(watts, 0.0, 100)
    assert np_val is not None
    assert if_val is None
    assert tss is None


def test_all_none_watts_treated_as_zero():
    # None values should be replaced with 0.0 without crashing
    watts = [None] * 100
    np_val, if_val, tss = _compute_np_if_tss(watts, 250.0, 100)
    assert np_val == 0


# ---------------------------------------------------------------------------
# Correctness
# ---------------------------------------------------------------------------

def test_constant_watts_np_equals_input():
    """
    For constant power, NP must equal that constant value.
    The 30-second rolling average of a constant is the constant itself,
    and the 4th-root of (constant^4) is the constant.
    """
    watts = [200.0] * 200
    np_val, _, _ = _compute_np_if_tss(watts, 250.0, 200)
    assert np_val == 200


def test_intensity_factor_at_ftp_is_one():
    """Riding at exactly FTP should produce IF = 1.0."""
    ftp = 250
    watts = [float(ftp)] * 200
    _, if_val, _ = _compute_np_if_tss(watts, ftp, 200)
    assert abs(if_val - 1.0) < 0.01


def test_one_hour_at_ftp_gives_tss_100():
    """
    The definition of TSS: 1 hour at FTP = 100 TSS.
    TSS = (duration_s * NP * IF) / (FTP * 3600) * 100
    With NP=FTP and IF=1.0: TSS = (3600 * FTP * 1) / (FTP * 3600) * 100 = 100
    """
    ftp = 250
    watts = [float(ftp)] * 3600
    _, _, tss = _compute_np_if_tss(watts, ftp, 3600)
    assert tss == 100


def test_tss_scales_with_duration():
    """30 minutes at FTP should give ~50 TSS."""
    ftp = 250
    watts = [float(ftp)] * 1800
    _, _, tss = _compute_np_if_tss(watts, ftp, 1800)
    assert abs(tss - 50) <= 1


def test_below_ftp_gives_tss_under_100_per_hour():
    """Riding below FTP for an hour should produce TSS < 100."""
    ftp = 250
    watts = [200.0] * 3600
    _, _, tss = _compute_np_if_tss(watts, ftp, 3600)
    assert tss < 100


def test_above_ftp_gives_tss_over_100_per_hour():
    """Riding above FTP for an hour should produce TSS > 100."""
    ftp = 250
    watts = [300.0] * 3600
    _, _, tss = _compute_np_if_tss(watts, ftp, 3600)
    assert tss > 100


def test_tss_is_always_positive():
    ftp = 250
    watts = [150.0] * 500
    _, _, tss = _compute_np_if_tss(watts, ftp, 500)
    assert tss > 0


def test_moving_s_none_falls_back_to_array_size():
    """When moving_s is None, duration defaults to len(watts)."""
    ftp = 250
    watts = [float(ftp)] * 3600
    _, _, tss_with_duration = _compute_np_if_tss(watts, ftp, 3600)
    _, _, tss_without_duration = _compute_np_if_tss(watts, ftp, None)
    assert tss_with_duration == tss_without_duration
