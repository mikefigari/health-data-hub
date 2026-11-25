"""Peloton ride number, milestone countdown email and Notion number.

The DB cursor, the Notion client and send_alert are faked; no network, no DB.
"""
import importlib
import logging
import runpy
import sys
from datetime import date
from unittest.mock import MagicMock

import pytest

SYNC = "health_data_hub.integrations.notion.notion_strava_sync"
PM = "health_data_hub.integrations.notion.peloton_milestone"

PELOTON_ROW = {
    "workout_id": 925,
    "name": "5 min Cool Down Ride with Jess King",
    "elevation_meters": 0,
    "sport_type": "VirtualRide",
    "workout_date": date(2026, 11, 24),
}
GARMIN_ROW = {**PELOTON_ROW, "workout_id": 222, "name": "Outdoor", "elevation_meters": 350}


# ---------------------------------------------------------------- fakes

class Row(tuple):
    """Result row readable by index, by column name, or with .get()."""

    def __new__(cls, *values, named=None):
        obj = super().__new__(cls, values)
        obj._named = named or {}
        obj._default = values[-1] if values else None
        return obj

    def __getitem__(self, key):
        if isinstance(key, str):
            return self._named.get(key, self._default)
        return super().__getitem__(key)

    def get(self, key, default=None):
        return self._named.get(key, self._default)


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)

    def __iter__(self):
        return iter(self.rows)


class FakeConn:
    def __init__(self, rows):
        self.cur = FakeCursor(rows)
        self.closed = False

    def cursor(self, *a, **k):
        return self.cur

    def close(self):
        self.closed = True

    def commit(self):
        pass


def _load_sync(monkeypatch):
    monkeypatch.setenv("NOTION_TOKEN", "test-token")
    monkeypatch.setenv("NOTION_WORKOUT_DB_ID", "test-db")
    monkeypatch.setenv("NOTION_DRY_RUN", "0")
    sys.modules.pop(SYNC, None)
    mod = importlib.import_module(SYNC)
    monkeypatch.setattr(mod, "NOTION_POWERZONE_DB_ID", None)
    monkeypatch.setattr(mod, "_apply_peloton_icon", lambda *a, **k: None)
    return mod


@pytest.fixture
def sync(monkeypatch):
    yield _load_sync(monkeypatch)
    sys.modules.pop(SYNC, None)


@pytest.fixture
def pm(monkeypatch):
    monkeypatch.setenv("NOTION_TOKEN", "test-token")
    monkeypatch.setenv("NOTION_WORKOUT_DB_ID", "test-db")
    return importlib.import_module(PM)


def _patch_both(monkeypatch, pm_mod, name, value, extra_mods=()):
    """Patch name on its home module and wherever it may have been imported."""
    monkeypatch.setattr(pm_mod, name, value, raising=False)
    for m in extra_mods:
        monkeypatch.setattr(m, name, value, raising=False)


def _patch_db(monkeypatch, pm_mod, conn):
    getter = lambda *a, **k: conn  # noqa: E731
    monkeypatch.setattr("health_data_hub.utils.db_connect.get_connection", getter)
    monkeypatch.setattr(pm_mod, "get_connection", getter, raising=False)


def _patch_alert(monkeypatch, pm_mod, *others):
    alert = MagicMock()
    monkeypatch.setattr("health_data_hub.utils.alert.send_alert", alert)
    monkeypatch.setattr(pm_mod, "send_alert", alert, raising=False)
    for m in others:
        monkeypatch.setattr(m, "send_alert", alert, raising=False)
    return alert


def _alert_subject(alert):
    call = alert.call_args
    if call.args:
        return call.args[0]
    return call.kwargs["subject"]


def _notion():
    notion = MagicMock()
    notion.request.return_value = {"results": []}
    notion.pages.create.return_value = {"id": "new-page"}
    notion.pages.update.return_value = {"id": "p"}
    return notion


def _call_has(call, *values):
    flat = list(call.args) + list(call.kwargs.values())
    return all(v in flat for v in values)


# ---------------------------------------------------------------- (a)

@pytest.mark.parametrize(
    "n,expected",
    [
        (675, None),
        (696, None),
        (697, (700, 3)),
        (698, (700, 2)),
        (699, (700, 1)),
        (700, (700, 0)),
        (701, None),
        (797, (800, 3)),
        (800, (800, 0)),
    ],
)
def test_milestone_countdown(pm, n, expected):
    assert pm.milestone_countdown(n) == expected


@pytest.mark.parametrize(
    "n,expected",
    [
        (675, None),
        (696, None),
        (697, "3 to 700"),
        (698, "2 to 700"),
        (699, "1 to 700"),
        (700, "Ride 700 \U0001F389"),
        (701, None),
        (797, "3 to 800"),
        (800, "Ride 800 \U0001F389"),
    ],
)
def test_milestone_text(pm, n, expected):
    assert pm.milestone_text(n) == expected


# ---------------------------------------------------------------- (b)

def test_offset_defaults_to_59_when_env_unset(monkeypatch):
    monkeypatch.delenv("PELOTON_RIDE_OFFSET", raising=False)
    import health_data_hub.config.settings as settings

    settings = importlib.reload(settings)
    assert settings.PELOTON_RIDE_OFFSET == 59


def test_ride_number_adds_offset_to_count(monkeypatch, pm):
    monkeypatch.setattr(pm, "PELOTON_RIDE_OFFSET", 59, raising=False)
    conn = FakeConn([Row(616, named={"count": 616})])
    _patch_db(monkeypatch, pm, conn)
    assert pm.peloton_ride_number(925) == 675
    assert conn.closed is True
    assert len(conn.cur.executed) == 1


@pytest.mark.parametrize("rows", [[], [None], [(None,)], [(0,)]])
def test_ride_number_none_for_missing_or_non_peloton(monkeypatch, pm, rows):
    conn = FakeConn(rows)
    _patch_db(monkeypatch, pm, conn)
    assert pm.peloton_ride_number(222) is None
    assert conn.closed is True


# ---------------------------------------------------------------- (c)

@pytest.mark.parametrize(
    "n,subject",
    [
        (697, "Peloton: 3 rides to 700 (ride 697)"),
        (698, "Peloton: 2 rides to 700 (ride 698)"),
        (699, "Peloton: 1 ride to 700 (ride 699)"),
        (700, "Peloton: ride 700 milestone!"),
    ],
)
def test_notify_milestone_sends_one_email(monkeypatch, pm, n, subject):
    alert = _patch_alert(monkeypatch, pm)
    pm.notify_milestone(n)
    assert alert.call_count == 1
    assert _alert_subject(alert) == subject


@pytest.mark.parametrize("n", [696, 701, 675])
def test_notify_milestone_silent_outside_window(monkeypatch, pm, n):
    alert = _patch_alert(monkeypatch, pm)
    pm.notify_milestone(n)
    alert.assert_not_called()


# ---------------------------------------------------------------- (d)

def test_set_notion_ride_number_with_milestone(pm):
    notion = MagicMock()
    pm.set_notion_ride_number(notion, "p1", 697)
    assert notion.pages.update.call_count == 1
    kwargs = notion.pages.update.call_args.kwargs
    assert kwargs["page_id"] == "p1"
    props = kwargs["properties"]
    assert props["Peloton #"] == {"number": 697}
    assert "3 to 700" in repr(props["Peloton Milestone"])


def test_set_notion_ride_number_without_milestone(pm):
    notion = MagicMock()
    pm.set_notion_ride_number(notion, "p1", 675)
    assert notion.pages.update.call_count == 1
    props = notion.pages.update.call_args.kwargs["properties"]
    assert props == {"Peloton #": {"number": 675}}


# ---------------------------------------------------------------- (e)

def test_upsert_peloton_sets_ride_number(monkeypatch, sync, pm):
    ride_no = MagicMock(return_value=675)
    setter = MagicMock()
    _patch_both(monkeypatch, pm, "peloton_ride_number", ride_no, [sync])
    _patch_both(monkeypatch, pm, "set_notion_ride_number", setter, [sync])
    page_id = sync.upsert_workout(_notion(), "test-db", PELOTON_ROW)
    assert page_id == "new-page"
    assert setter.call_count == 1
    assert _call_has(setter.call_args, "new-page", 675)


def test_upsert_garmin_does_not_set_ride_number(monkeypatch, sync, pm):
    setter = MagicMock()
    _patch_both(monkeypatch, pm, "peloton_ride_number", MagicMock(return_value=5), [sync])
    _patch_both(monkeypatch, pm, "set_notion_ride_number", setter, [sync])
    assert sync.upsert_workout(_notion(), "test-db", GARMIN_ROW) == "new-page"
    setter.assert_not_called()


def test_upsert_survives_set_failure_and_warns(monkeypatch, sync, pm, caplog):
    setter = MagicMock(side_effect=RuntimeError("property missing"))
    _patch_both(monkeypatch, pm, "peloton_ride_number", MagicMock(return_value=675), [sync])
    _patch_both(monkeypatch, pm, "set_notion_ride_number", setter, [sync])
    with caplog.at_level(logging.DEBUG):
        page_id = sync.upsert_workout(_notion(), "test-db", PELOTON_ROW)
    assert page_id == "new-page"
    assert setter.call_count == 1
    assert any(r.levelno >= logging.WARNING for r in caplog.records)


# ---------------------------------------------------------------- (f)

def _wire_sync(monkeypatch, sync, pm, ride_number):
    alert = _patch_alert(monkeypatch, pm, sync)
    _patch_both(monkeypatch, pm, "peloton_ride_number", MagicMock(return_value=ride_number), [sync])
    _patch_both(monkeypatch, pm, "set_notion_ride_number", MagicMock(), [sync])
    monkeypatch.setattr(sync, "Client", lambda *a, **k: _notion())
    monkeypatch.setattr(sync, "fetch_summary_row", lambda wid: dict(PELOTON_ROW, workout_id=wid))
    monkeypatch.setattr(sync, "fetch_workouts_since", lambda since: [dict(PELOTON_ROW)])
    return alert


def test_sync_specific_workout_emails_at_milestone(monkeypatch, sync, pm):
    alert = _wire_sync(monkeypatch, sync, pm, 699)
    sync.sync_specific_workout(925)
    assert alert.call_count == 1
    assert _alert_subject(alert) == "Peloton: 1 ride to 700 (ride 699)"


def test_sync_specific_workout_no_email_outside_window(monkeypatch, sync, pm):
    alert = _wire_sync(monkeypatch, sync, pm, 675)
    sync.sync_specific_workout(925)
    alert.assert_not_called()


def test_bulk_sync_never_emails(monkeypatch, sync, pm):
    alert = _wire_sync(monkeypatch, sync, pm, 699)
    sync.sync_to_notion(date(2026, 11, 24))
    alert.assert_not_called()


# ---------------------------------------------------------------- (g)

def _backfill_wiring(monkeypatch, sync, pm):
    rows = [
        Row(924, date(2026, 11, 23), 674, named={"workout_id": 924, "workout_date": date(2026, 11, 23)}),
        Row(925, date(2026, 11, 24), 675, named={"workout_id": 925, "workout_date": date(2026, 11, 24)}),
    ]
    conn = FakeConn(rows)
    _patch_db(monkeypatch, pm, conn)
    numbers = {924: 674, 925: 675}
    _patch_both(
        monkeypatch, pm, "peloton_ride_number", lambda wid: numbers.get(wid, 675)
    )
    monkeypatch.setattr(sync, "_find_page_id", lambda notion, db, wid: {"id": f"page-{wid}"})
    notion = _notion()
    monkeypatch.setattr("notion_client.Client", lambda *a, **k: notion)
    monkeypatch.setattr(sync, "Client", lambda *a, **k: notion, raising=False)
    monkeypatch.setattr(pm, "Client", lambda *a, **k: notion, raising=False)
    return notion


def test_backfill_updates_pages_without_email(monkeypatch, sync, pm):
    notion = _backfill_wiring(monkeypatch, sync, pm)
    alert = _patch_alert(monkeypatch, pm, sync)
    setter = MagicMock()
    monkeypatch.setattr(pm, "set_notion_ride_number", setter)
    assert pm.backfill(last_n=2) == 2
    assert setter.call_count == 2
    alert.assert_not_called()
    notion.pages.create.assert_not_called()


def test_backfill_dry_run_makes_no_notion_write(monkeypatch, sync, pm):
    notion = _backfill_wiring(monkeypatch, sync, pm)
    alert = _patch_alert(monkeypatch, pm, sync)
    monkeypatch.setattr(
        "health_data_hub.utils.logging_config.setup_logging", lambda *a, **k: None
    )
    monkeypatch.setattr(sys, "argv", ["peloton_milestone", "--last", "2", "--dry-run"])
    sys.modules.pop(PM, None)
    runpy.run_module(PM, run_name="__main__")
    notion.pages.update.assert_not_called()
    alert.assert_not_called()
