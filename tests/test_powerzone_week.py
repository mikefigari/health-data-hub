"""Cycling rides link to the Power Zone week covering their LA date (T2).

Notion REST (requests), notion_client.Client and the DB connection are faked;
no network or DB access is made.
"""
import importlib
import logging
import sys
from datetime import date
from unittest.mock import MagicMock

import pytest

MODULE = "health_data_hub.integrations.notion.notion_strava_sync"
PZW = "health_data_hub.integrations.notion.powerzone_week"
PZ_DB = "157993b9020180489de0fad236261f18"
TEMPLATE_ID = "171993b9020180f9a6bef0bff3e21c1e"
DATE_PROP = "Week"

STAR = "⭐"
QUESTION = "❓"
LEG = "\U0001F9B5\U0001F3FB"
STAR_ICON = {"type": "emoji", "emoji": STAR}
QUESTION_ICON = {"type": "emoji", "emoji": QUESTION}
LEG_ICON = {"type": "emoji", "emoji": LEG}
TEMPLATE_COVER = {"type": "external", "external": {"url": "https://example.invalid/cover.jpg"}}

CYCLING_ROW = {
    "workout_id": 901,
    "name": "Outdoor ride",
    "elevation_meters": 350,
    "sport_type": "Ride",
    "workout_date": date(2026, 11, 16),
}
RUN_ROW = {**CYCLING_ROW, "workout_id": 902, "name": "Run", "sport_type": "Run"}


def pz_page(pid, start, end, program, week_label, icon, ftp=None):
    return {
        "id": pid,
        "icon": icon,
        "cover": None,
        "properties": {
            "Program Name": {"type": "title", "title": [{"plain_text": program, "text": {"content": program}}]},
            DATE_PROP: {"type": "date", "date": {"start": start, "end": end}},
            "Week #": {
                "type": "rich_text",
                "rich_text": [{"plain_text": week_label, "text": {"content": week_label}}],
            },
            "FTP": {"type": "number", "number": ftp},
        },
    }


def template_page(title="RPZ-29"):
    return {
        "id": TEMPLATE_ID,
        "icon": STAR_ICON,
        "cover": TEMPLATE_COVER,
        "properties": {
            "Program Name": {"type": "title", "title": [{"plain_text": title, "text": {"content": title}}]},
        },
    }


class FakeResponse:
    status_code = 200
    text = ""

    def __init__(self, payload=None):
        self._payload = payload if payload is not None else {}

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _walk_filters(flt):
    if not isinstance(flt, dict):
        return
    for key in ("and", "or"):
        for sub in flt.get(key, []) or []:
            yield from _walk_filters(sub)
    if "property" in flt:
        yield flt


def _start(page):
    return page["properties"][DATE_PROP]["date"]["start"]


def _title(page):
    return page["properties"]["Program Name"]["title"][0]["plain_text"]


class FakeRequests:
    def __init__(self, pages, template=None):
        self.pages = pages
        self.template = template or template_page()
        self.calls = []  # (method, url, kwargs)

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        if TEMPLATE_ID in url.replace("-", ""):
            return FakeResponse(self.template)
        return FakeResponse({})

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        if url.rstrip("/").endswith("/query"):
            return FakeResponse(self._query(kwargs.get("json") or {}))
        if url.rstrip("/").endswith("/pages"):
            return FakeResponse({"id": "new-week"})
        return FakeResponse({})

    def patch(self, url, **kwargs):
        self.calls.append(("PATCH", url, kwargs))
        return FakeResponse({})

    def delete(self, url, **kwargs):
        self.calls.append(("DELETE", url, kwargs))
        return FakeResponse({})

    def _query(self, body):
        results = list(self.pages)
        for f in _walk_filters(body.get("filter")):
            if f["property"] == DATE_PROP and "date" in f:
                cond = f["date"]
                if "on_or_before" in cond:
                    results = [p for p in results if _start(p) <= cond["on_or_before"]]
                if "on_or_after" in cond:
                    results = [p for p in results if _start(p) >= cond["on_or_after"]]
            elif f["property"] == "Program Name" and "title" in f:
                cond = f["title"]
                if "equals" in cond:
                    results = [p for p in results if _title(p) == cond["equals"]]
                if "contains" in cond:
                    results = [p for p in results if cond["contains"] in _title(p)]
        if body.get("sorts"):
            desc = body["sorts"][0].get("direction") == "descending"
            results.sort(key=_start, reverse=desc)
        size = body.get("page_size") or 100
        offset = int(body.get("start_cursor") or 0)
        chunk = results[offset:offset + size]
        more = offset + size < len(results)
        return {
            "results": chunk,
            "has_more": more,
            "next_cursor": str(offset + size) if more else None,
        }

    # helpers
    def queries(self):
        return [c for c in self.calls if c[0] == "POST" and c[1].rstrip("/").endswith("/query")]

    def creates(self):
        return [c for c in self.calls if c[0] == "POST" and c[1].rstrip("/").endswith("/pages")]

    def icon_patches(self):
        return [
            c for c in self.calls
            if c[0] == "PATCH" and isinstance(c[2].get("json"), dict) and "icon" in c[2]["json"]
        ]


def _text(prop, kind):
    item = prop[kind][0]
    return item.get("plain_text") or item["text"]["content"]


@pytest.fixture
def load(monkeypatch):
    def _do(pages, template=None, db_id=PZ_DB):
        monkeypatch.setenv("NOTION_TOKEN", "test-token")
        monkeypatch.setenv("NOTION_WORKOUT_DB_ID", "test-db")
        monkeypatch.setenv("NOTION_DRY_RUN", "0")
        monkeypatch.setenv("NOTION_POWERZONE_DB_ID", db_id or "")
        monkeypatch.setenv("NOTION_POWERZONE_DATE_PROP", DATE_PROP)
        sys.modules.pop(MODULE, None)
        sys.modules.pop(PZW, None)
        mod = importlib.import_module(MODULE)
        pzw = importlib.import_module(PZW)
        fake = FakeRequests(pages, template)
        for m in (mod, pzw):
            monkeypatch.setattr(m, "requests", fake)
            monkeypatch.setattr(m, "NOTION_POWERZONE_DB_ID", db_id, raising=False)
            monkeypatch.setattr(m, "NOTION_POWERZONE_DATE_PROP", DATE_PROP, raising=False)
        return mod, pzw, fake

    yield _do
    sys.modules.pop(MODULE, None)
    sys.modules.pop(PZW, None)


class Row(tuple):
    """Supports both row[0] and row['col'] (tuple and dict cursors)."""

    def __getitem__(self, key):
        if isinstance(key, str):
            return tuple.__getitem__(self, 0)
        return tuple.__getitem__(self, key)

    def get(self, key, default=None):
        return tuple.__getitem__(self, 0)


def fake_conn(local_date):
    cur = MagicMock()
    cur.__enter__.return_value = cur
    cur.fetchone.return_value = Row((local_date,)) if local_date is not None else None
    conn = MagicMock()
    conn.cursor.return_value = cur
    return conn, cur


def _norm_sql(cur):
    sql = cur.execute.call_args_list[0].args[0]
    return " ".join(str(sql).split()).lower()


# ---------------------------------------------------------------- pure helpers

def test_week_bounds_monday_to_sunday(load):
    _, pzw, _ = load([])
    assert pzw.week_bounds(date(2026, 11, 16)) == (date(2026, 11, 16), date(2026, 11, 22))
    assert pzw.week_bounds(date(2026, 11, 22)) == (date(2026, 11, 16), date(2026, 11, 22))
    assert pzw.week_bounds(date(2026, 11, 18)) == (date(2026, 11, 16), date(2026, 11, 22))


def test_next_week_label(load):
    _, pzw, _ = load([])
    assert pzw.next_week_label(["Week 1"]) == "Week 2"
    assert pzw.next_week_label(["Week 9", "Week 10"]) == "Week 11"
    assert pzw.next_week_label([]) == "Week 1"
    assert pzw.next_week_label(["Week Off"]) == "Week 1"


# ----------------------------------------------------------- find_or_create

def test_existing_covering_page_is_returned_without_create(load):
    pages = [
        pz_page("p-old", "2026-11-02", "2026-11-08", "RPZ-28", "Week 4", LEG_ICON, 240),
        pz_page("p-cover", "2026-11-09", "2026-11-15", "RPZ-29", "Week 1", STAR_ICON, 245),
    ]
    _, pzw, fake = load(pages)
    assert pzw.find_or_create_week_page(date(2026, 11, 12)) == "p-cover"
    assert fake.creates() == []
    assert fake.icon_patches() == []


def test_new_week_page_created_from_template(load):
    pages = [
        pz_page("p-new", "2026-11-09", "2026-11-15", "RPZ-29", "Week 1", STAR_ICON, None),
        pz_page("p-mid", "2026-11-02", "2026-11-08", "RPZ-28", "Week 4", LEG_ICON, 245),
        pz_page("p-old", "2026-10-26", "2026-11-01", "RPZ-28", "Week 3", LEG_ICON, 240),
    ]
    _, pzw, fake = load(pages)
    result = pzw.find_or_create_week_page(date(2026, 11, 16))
    assert result == "new-week"

    creates = fake.creates()
    assert len(creates) == 1
    payload = creates[0][2]["json"]
    assert payload["parent"]["database_id"].replace("-", "") == PZ_DB
    props = payload["properties"]
    assert _text(props["Program Name"], "title") == "RPZ-29"
    assert props[DATE_PROP]["date"]["start"] == "2026-11-16"
    assert props[DATE_PROP]["date"]["end"] == "2026-11-22"
    assert _text(props["Week #"], "rich_text") == "Week 2"
    assert props["FTP"]["number"] == 245
    assert payload["icon"] == STAR_ICON
    assert payload["cover"] == TEMPLATE_COVER
    assert "Weight (kg)" not in props

    # Star handoff: only the earlier star page becomes a question mark.
    patches = fake.icon_patches()
    patched = {c[1].rstrip("/").rsplit("/", 1)[-1].replace("-", ""): c for c in patches}
    assert set(patched) == {"p-new".replace("-", "")}
    assert patched["pnew"][2]["json"]["icon"] == QUESTION_ICON
    # and it happens after the new page exists
    assert fake.calls.index(creates[0]) < fake.calls.index(patches[0])


def test_new_program_starts_at_week_1(load):
    pages = [pz_page("p-prev", "2026-11-09", "2026-11-15", "RPZ-29", "Week 3", LEG_ICON, 250)]
    _, pzw, fake = load(pages, template=template_page("RPZ-30"))
    assert pzw.find_or_create_week_page(date(2026, 11, 16)) == "new-week"
    props = fake.creates()[0][2]["json"]["properties"]
    assert _text(props["Program Name"], "title") == "RPZ-30"
    assert _text(props["Week #"], "rich_text") == "Week 1"


def test_older_uncovered_ride_is_not_linked_and_creates_nothing(load):
    pages = [
        pz_page("p-new", "2026-11-09", "2026-11-15", "RPZ-29", "Week 1", STAR_ICON, 245),
        pz_page("p-old", "2026-10-19", "2026-10-25", "RPZ-28", "Week 1", LEG_ICON, 240),
    ]
    _, pzw, fake = load(pages)
    assert pzw.find_or_create_week_page(date(2026, 11, 3)) is None
    assert fake.creates() == []
    assert fake.icon_patches() == []


def test_two_rides_same_new_week_create_one_page(load):
    pages = [pz_page("p-prev", "2026-11-09", "2026-11-15", "RPZ-29", "Week 1", STAR_ICON, 245)]
    _, pzw, fake = load(pages)
    first = pzw.find_or_create_week_page(date(2026, 11, 16))
    queries_after_first = len(fake.queries())
    second = pzw.find_or_create_week_page(date(2026, 11, 18))
    assert first == second == "new-week"
    assert len(fake.creates()) == 1
    assert len(fake.queries()) == queries_after_first  # served from the cache


# ------------------------------------------------------------ LA local date

def test_ride_local_date_sql_uses_la_timezone(load, monkeypatch):
    _, pzw, _ = load([])
    conn, cur = fake_conn(date(2026, 11, 22))
    monkeypatch.setattr(pzw, "get_connection", lambda: conn)
    result = pzw.ride_local_date(901, date(2026, 11, 23))
    assert result == date(2026, 11, 22)
    sql = _norm_sql(cur)
    assert "america/los_angeles" in sql
    assert "::date" in sql
    assert sql.index("america/los_angeles") < sql.index("::date")
    assert "workout_summary" in sql
    params = cur.execute.call_args_list[0].args[1]
    assert 901 in tuple(params)


def test_ride_local_date_falls_back_when_no_row(load, monkeypatch):
    _, pzw, _ = load([])
    conn, _cur = fake_conn(None)
    monkeypatch.setattr(pzw, "get_connection", lambda: conn)
    assert pzw.ride_local_date(901, date(2026, 11, 23)) == date(2026, 11, 23)


def test_utc_next_day_ride_links_to_la_week(load, monkeypatch):
    pages = [
        pz_page("p-wk47", "2026-11-16", "2026-11-22", "RPZ-29", "Week 2", STAR_ICON, 245),
        pz_page("p-wk48", "2026-11-23", "2026-11-29", "RPZ-29", "Week 3", STAR_ICON, 245),
    ]
    mod, pzw, fake = load(pages)
    conn, _cur = fake_conn(date(2026, 11, 22))
    monkeypatch.setattr(pzw, "get_connection", lambda: conn)
    row = {**CYCLING_ROW, "workout_date": date(2026, 11, 23)}
    notion = _notion(existing_page=_existing("pg-1", []))
    assert mod.upsert_workout(notion, "test-db", row) == "pg-1"
    assert _relation_updates(notion) == [[{"id": "p-wk47"}]]
    assert fake.creates() == []


# ------------------------------------------------------------ upsert_workout

def _existing(pid, relation):
    return {"id": pid, "icon": None, "properties": {"PowerZone [DB]": {"relation": relation}}}


def _notion(existing_page=None, new_id="new-page"):
    notion = MagicMock()
    notion.request.return_value = {"results": [existing_page] if existing_page else []}
    notion.pages.create.return_value = {"id": new_id}
    notion.pages.update.return_value = {"id": (existing_page or {}).get("id", "x")}
    return notion


def _relation_updates(notion):
    out = []
    for call in notion.pages.update.call_args_list:
        props = call.kwargs.get("properties") or {}
        if "PowerZone [DB]" in props:
            out.append(props["PowerZone [DB]"]["relation"])
    return out


COVER_PAGES = [pz_page("p-cover", "2026-11-16", "2026-11-22", "RPZ-29", "Week 2", STAR_ICON, 245)]


def test_upsert_cycling_empty_relation_gets_linked(load, monkeypatch):
    mod, pzw, _fake = load(COVER_PAGES)
    conn, _ = fake_conn(date(2026, 11, 17))
    monkeypatch.setattr(pzw, "get_connection", lambda: conn)
    notion = _notion(existing_page=_existing("pg-1", []))
    assert mod.upsert_workout(notion, "test-db", CYCLING_ROW) == "pg-1"
    assert _relation_updates(notion) == [[{"id": "p-cover"}]]


def test_upsert_new_page_cycling_gets_linked(load, monkeypatch):
    mod, pzw, _fake = load(COVER_PAGES)
    conn, _ = fake_conn(date(2026, 11, 17))
    monkeypatch.setattr(pzw, "get_connection", lambda: conn)
    notion = _notion()
    assert mod.upsert_workout(notion, "test-db", CYCLING_ROW) == "new-page"
    update_calls = [c for c in notion.pages.update.call_args_list
                    if "PowerZone [DB]" in (c.kwargs.get("properties") or {})]
    assert len(update_calls) == 1
    assert update_calls[0].kwargs["page_id"] == "new-page"


def test_upsert_non_empty_relation_is_left_alone(load, monkeypatch):
    mod, pzw, _fake = load(COVER_PAGES)
    conn, _ = fake_conn(date(2026, 11, 17))
    monkeypatch.setattr(pzw, "get_connection", lambda: conn)
    notion = _notion(existing_page=_existing("pg-1", [{"id": "manual-choice"}]))
    assert mod.upsert_workout(notion, "test-db", CYCLING_ROW) == "pg-1"
    assert _relation_updates(notion) == []


def test_upsert_non_cycling_row_is_not_linked(load, monkeypatch):
    mod, pzw, fake = load(COVER_PAGES)
    conn, _ = fake_conn(date(2026, 11, 17))
    monkeypatch.setattr(pzw, "get_connection", lambda: conn)
    notion = _notion(existing_page=_existing("pg-2", []))
    assert mod.upsert_workout(notion, "test-db", RUN_ROW) == "pg-2"
    assert _relation_updates(notion) == []
    assert fake.queries() == []


def test_upsert_error_is_logged_and_page_id_returned(load, monkeypatch, caplog):
    mod, pzw, _fake = load(COVER_PAGES)

    def boom(*args, **kwargs):
        raise RuntimeError("powerzone boom")

    monkeypatch.setattr(pzw, "find_or_create_week_page", boom)
    monkeypatch.setattr(mod, "find_or_create_week_page", boom, raising=False)
    conn, _ = fake_conn(date(2026, 11, 17))
    monkeypatch.setattr(pzw, "get_connection", lambda: conn)
    notion = _notion(existing_page=_existing("pg-1", []))
    with caplog.at_level(logging.DEBUG):
        page_id = mod.upsert_workout(notion, "test-db", CYCLING_ROW)
    assert page_id == "pg-1"
    assert _relation_updates(notion) == []
    assert any(r.levelno >= logging.WARNING for r in caplog.records)


def test_powerzone_db_unset_makes_no_powerzone_calls(load, monkeypatch):
    mod, pzw, fake = load(COVER_PAGES, db_id=None)
    conn, _ = fake_conn(date(2026, 11, 17))
    monkeypatch.setattr(pzw, "get_connection", lambda: conn)
    notion = _notion(existing_page=_existing("pg-1", []))
    assert mod.upsert_workout(notion, "test-db", CYCLING_ROW) == "pg-1"
    assert fake.queries() == []
    assert fake.creates() == []
    assert _relation_updates(notion) == []
