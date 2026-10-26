"""Unit tests for health_data_hub.etl.transform.build_nutrition_charts (no DB, no network)."""

from __future__ import annotations

from datetime import date

from health_data_hub.etl.transform import build_nutrition_charts as b

TODAY = date(2026, 10, 26)  # a Monday


def _day(d, cal, prot, gcal=2620, gprot=180, complete=True):
    return {"day": d, "calories": cal, "protein_g": prot, "goal_calories": gcal,
            "goal_protein_g": gprot, "logged_complete": complete}


def test_weight_trailing_average_uses_calendar_window():
    rows = b.build_weight_rows([
        (date(2026, 10, 1), 100), (date(2026, 10, 3), 102), (date(2026, 10, 12), 110),
    ])
    assert [r["avg_kg"] for r in rows] == [100.0, 101.0, 110.0]  # Oct 12 is outside both windows


def test_weight_csv_header_and_values():
    csv_text = b.weight_csv(b.build_weight_rows([(date(2026, 10, 26), 115.6)]))
    assert csv_text == "date,Weight (kg),7-day average (kg)\n2026-10-26,115.6,115.6\n"


def test_daily_rows_cover_14_days_and_blank_unlogged():
    rows = b.build_daily_rows([_day(date(2026, 10, 25), 3802, 224.5),
                               _day(date(2026, 10, 24), 900, 40, complete=False)], TODAY)
    assert len(rows) == 14
    assert rows[0]["date"] == date(2026, 10, 13) and rows[-1]["date"] == TODAY
    by = {r["date"]: r for r in rows}
    assert by[date(2026, 10, 25)]["calories"] == 3802
    assert by[date(2026, 10, 25)]["protein_g"] == 224.5
    assert by[date(2026, 10, 24)]["calories"] is None  # not confirmed complete


def test_weekly_counts_goal_met_days():
    nutrition = [
        _day(date(2026, 10, 19), 2500, 190),   # both met
        _day(date(2026, 10, 20), 3000, 190),   # protein only
        _day(date(2026, 10, 21), 2500, 100),   # calories only
        _day(date(2026, 10, 22), 3000, 100),   # neither
        _day(date(2026, 10, 23), 2500, 190, complete=False),  # ignored
    ]
    weeks = b.build_weekly_rows(nutrition, TODAY)
    assert len(weeks) == 8
    wk = {w["week_of"]: w for w in weeks}[date(2026, 10, 19)]
    assert (wk["protein_met"], wk["calories_met"], wk["logged"]) == (2, 2, 4)
    assert weeks[-1]["week_of"] == TODAY and weeks[-1]["logged"] == 0


def test_weekly_skips_days_without_goal():
    weeks = b.build_weekly_rows([_day(date(2026, 10, 19), 2500, 190, gcal=None, gprot=None)], TODAY)
    wk = {w["week_of"]: w for w in weeks}[date(2026, 10, 19)]
    assert (wk["protein_met"], wk["calories_met"], wk["logged"]) == (0, 0, 1)
