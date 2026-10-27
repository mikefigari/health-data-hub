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


def test_ring_under_goal():
    r = b.build_ring(1210, 2627, "kcal")
    assert r["title"] == "1,210 of 2,627 kcal" and r["intro"] == "1,417 kcal left"
    assert r["csv"] == "label,value\nEaten,1210\nLeft,1417\n"


def test_ring_over_goal_is_full_and_says_over():
    r = b.build_ring(3802, 2620, "kcal")
    assert r["csv"] == "label,value\nEaten,3802\nLeft,0\n" and r["intro"] == "1,182 kcal over"


def test_ring_nothing_eaten_yet_and_no_goal():
    assert b.build_ring(None, 180, "g protein")["csv"] == "label,value\nEaten,0\nLeft,180\n"
    assert b.build_ring(50, None, "g protein") is None


def test_charts_include_rings_only_with_goals():
    from health_data_hub.integrations.datawrapper.nutrition_charts import _charts
    today = {"calories": 400, "protein_g": 54.9, "goal_calories": 2620, "goal_protein_g": None}
    charts = _charts([], b.build_daily_rows([], TODAY), b.build_weekly_rows([], TODAY), today)
    assert "ring_calories" in charts and "ring_protein" not in charts
    assert charts["ring_calories"]["type"] == "d3-donuts"
