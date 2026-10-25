"""
Unit tests for health_data_hub.etl.transform.build_ftp_wkg.

Input contract (chosen by the spec): ftp_rows and weight_rows are lists of
(datetime.date, number) tuples. build_rows returns a list of dicts with keys
date (datetime.date), ftp_w, weight_kg, wkg, weight_source.
No network, no database.

Run:
    pytest tests/test_build_ftp_wkg.py -v
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest

from health_data_hub.etl.transform import build_ftp_wkg as b


def by_date(rows):
    return {r["date"]: r for r in rows}


D0 = date(2024, 1, 1)


def test_a_interpolates_between_neighbours():
    ftp_day = date(2024, 3, 11)
    rows = b.build_rows(
        [(D0, 200), (ftp_day, 200)],
        [(ftp_day - timedelta(days=10), 100.0), (ftp_day + timedelta(days=10), 102.0)],
    )
    r = by_date(rows)[ftp_day]
    assert float(r["weight_kg"]) == pytest.approx(101.0)
    assert r["weight_source"] == "interpolated"


def test_b_only_earlier_weighin_is_nearest():
    ftp_day = date(2024, 3, 11)
    rows = b.build_rows([(D0, 200), (ftp_day, 210)], [(date(2024, 3, 1), 100.0)])
    r = by_date(rows)[ftp_day]
    assert float(r["weight_kg"]) == pytest.approx(100.0)
    assert r["weight_source"] == "nearest"


def test_c_weighins_carry_latest_ftp_and_are_measured():
    rows = b.build_rows(
        [(D0, 200), (date(2024, 6, 1), 220)],
        [(date(2024, 2, 1), 100.0), (date(2024, 5, 31), 99.0), (date(2024, 6, 2), 98.0)],
    )
    m = by_date(rows)
    assert m[date(2024, 2, 1)]["ftp_w"] == 200
    assert m[date(2024, 5, 31)]["ftp_w"] == 200
    assert m[date(2024, 6, 2)]["ftp_w"] == 220
    for d in (date(2024, 2, 1), date(2024, 5, 31), date(2024, 6, 2)):
        assert m[d]["weight_source"] == "measured"


def test_d_weighins_before_first_ftp_excluded_but_used_for_interpolation():
    rows = b.build_rows(
        [(D0, 200)],
        [(date(2023, 12, 22), 100.0), (date(2024, 1, 11), 102.0)],
    )
    m = by_date(rows)
    assert date(2023, 12, 22) not in m
    assert min(m) >= D0
    assert float(m[D0]["weight_kg"]) == pytest.approx(101.0)
    assert m[D0]["weight_source"] == "interpolated"


def test_e_weighin_on_ftp_date_is_single_measured_row():
    rows = b.build_rows([(D0, 200)], [(D0, 100.0), (date(2024, 1, 5), 101.0)])
    same = [r for r in rows if r["date"] == D0]
    assert len(same) == 1
    assert same[0]["weight_source"] == "measured"
    assert float(same[0]["weight_kg"]) == pytest.approx(100.0)


def test_f_wkg_rounded_to_two_places():
    rows = b.build_rows([(D0, 215)], [(D0, 116.0)])
    assert float(rows[0]["wkg"]) == pytest.approx(1.85)
    rows = b.build_rows([(D0, 250)], [(D0, 77.0)])  # 3.2467...
    assert float(rows[0]["wkg"]) == pytest.approx(3.25)


def test_g_sorted_ascending_unique_dates():
    rows = b.build_rows(
        [(date(2024, 6, 1), 220), (D0, 200)],
        [(date(2024, 6, 1), 99.0), (date(2024, 3, 1), 100.0), (date(2024, 1, 15), 101.0)],
    )
    dates = [r["date"] for r in rows]
    assert dates == sorted(dates)
    assert len(dates) == len(set(dates))


def test_h_csv_header_and_iso_dates():
    rows = b.build_rows([(D0, 215)], [(D0, 116.0)])
    lines = b.to_csv(rows).strip().splitlines()
    assert lines[0] == "date,ftp_w,weight_kg,wkg,weight_source"
    cells = lines[1].split(",")
    assert cells[0] == "2024-01-01"
    assert cells[1] == "215"
    assert float(cells[2]) == pytest.approx(116.0)
    assert float(cells[3]) == pytest.approx(1.85)
    assert cells[4] == "measured"
    assert len(lines) == 2


def test_i_fetch_inputs_converts_timezone_in_sql():
    conn = MagicMock()
    cur = MagicMock()
    cur.fetchall.return_value = []
    conn.cursor.return_value = cur
    cur.__enter__.return_value = cur
    b.fetch_inputs(conn)
    sqls = [str(c.args[0]) for c in cur.execute.call_args_list]
    assert sqls, "fetch_inputs executed no SQL"
    ftp_sql = [s for s in sqls if "ftp_history" in s]
    assert ftp_sql
    assert "AT TIME ZONE 'America/Los_Angeles'" in ftp_sql[0]
    assert any("body_weight_daily" in s for s in sqls)


def test_j_empty_ftp_returns_empty():
    assert b.build_rows([], [(D0, 100.0)]) == []
    assert b.build_rows([], []) == []
