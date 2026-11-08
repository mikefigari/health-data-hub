"""The weekly power-zone summary picks rides by America/Los_Angeles start
date, not UTC date. The DB is mocked; no connection is made.
"""
import re
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock, patch

from health_data_hub.etl.transform import power_zone_graph

MODULE_PATH = Path(power_zone_graph.__file__)
MONDAY = date(2026, 11, 2)
SUNDAY = date(2026, 11, 8)


def _run_weekly_query():
    cur = MagicMock()
    cur.fetchall.return_value = []
    cur.fetchone.return_value = None
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    with patch.object(power_zone_graph, "get_connection", return_value=conn):
        power_zone_graph._fetch_weekly_zone_data(MONDAY, SUNDAY)
    assert cur.execute.call_count >= 1
    return cur.execute.call_args_list[0]


def _normalized_sql(call):
    return re.sub(r"\s+", " ", call.args[0]).lower()


def test_weekly_query_converts_utc_to_los_angeles_before_date_cast():
    sql = _normalized_sql(_run_weekly_query())
    m = re.search(r"where (.*?) between", sql)
    assert m, sql
    expr = m.group(1)
    assert "start_time" in expr
    assert "america/los_angeles" in expr
    assert expr.rstrip().endswith("::date")
    assert expr.index("america/los_angeles") < expr.rindex("::date")


def test_no_bare_start_time_date_cast_remains():
    source = MODULE_PATH.read_text(encoding="utf-8")
    assert not re.search(r"start_time\s*::\s*date", source)


def test_weekly_query_params_are_monday_and_sunday_unchanged():
    call = _run_weekly_query()
    params = call.args[1]
    assert tuple(params) == (MONDAY, SUNDAY)
