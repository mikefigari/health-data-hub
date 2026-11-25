"""Progress toward the next 100th Peloton ride, written to Notion.

The DB cursor and the Notion client are faked; no network, no DB.
"""
import importlib
from datetime import date
from unittest.mock import MagicMock

import pytest

SYNC = "health_data_hub.integrations.notion.notion_strava_sync"
PM = "health_data_hub.integrations.notion.peloton_milestone"


@pytest.fixture
def pm(monkeypatch):
    monkeypatch.setenv("NOTION_TOKEN", "test-token")
    monkeypatch.setenv("NOTION_WORKOUT_DB_ID", "test-db")
    return importlib.import_module(PM)


# ---------------------------------------------------------------- formula

@pytest.mark.parametrize(
    "n,expected",
    [
        (675, 0.75),
        (701, 0.01),
        (699, 0.99),
        (700, 1.0),
        (703, 0.03),
        (650, 0.5),
    ],
)
def test_milestone_progress(pm, n, expected):
    assert pm.milestone_progress(n) == expected


def test_milestone_progress_stays_in_range(pm):
    for n in range(1, 1001):
        assert 0 < pm.milestone_progress(n) <= 1, n


# ---------------------------------------------------------------- Notion write

def _sent_properties(pm, n):
    notion = MagicMock()
    pm.set_notion_ride_number(notion, "p1", n)
    assert notion.pages.update.call_count == 1
    kwargs = notion.pages.update.call_args.kwargs
    assert kwargs["page_id"] == "p1"
    return kwargs["properties"]


def test_set_ride_number_sends_progress_in_same_call(pm):
    props = _sent_properties(pm, 675)
    assert props["Peloton #"] == {"number": 675}
    assert props["Milestone progress"] == {"number": 0.75}


def test_set_ride_number_sends_progress_with_milestone_text(pm):
    props = _sent_properties(pm, 697)
    assert props["Peloton #"] == {"number": 697}
    assert props["Milestone progress"] == {"number": 0.97}
    assert props["Peloton Milestone"] == {
        "rich_text": [{"text": {"content": "3 to 700"}}]
    }


def test_set_ride_number_full_progress_on_milestone_ride(pm):
    props = _sent_properties(pm, 700)
    assert props["Milestone progress"] == {"number": 1.0}


# ---------------------------------------------------------------- backfill

def test_backfill_sends_progress_to_each_page(monkeypatch, pm):
    monkeypatch.setenv("NOTION_DRY_RUN", "0")
    sync = importlib.import_module(SYNC)

    rows = [(925, date(2026, 11, 24)), (924, date(2026, 11, 23))]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value.fetchall.return_value = rows
    monkeypatch.setattr(pm, "get_connection", lambda *a, **k: conn)
    monkeypatch.setattr(pm, "peloton_ride_number", {925: 675, 924: 674}.get)
    monkeypatch.setattr(sync, "_find_page_id", lambda notion, db, wid: {"id": f"page-{wid}"})
    notion = MagicMock()
    monkeypatch.setattr(pm, "Client", lambda *a, **k: notion)

    assert pm.backfill(last_n=2) == 2

    sent = {
        c.kwargs["page_id"]: c.kwargs["properties"]["Milestone progress"]
        for c in notion.pages.update.call_args_list
    }
    assert notion.pages.update.call_count == 2
    assert sent == {"page-925": {"number": 0.75}, "page-924": {"number": 0.74}}
