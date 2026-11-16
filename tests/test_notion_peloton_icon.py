"""Peloton rides get the Peloton template page's icon when their icon is empty.

Notion REST (requests) and the notion_client.Client are faked; no network or
DB connection is made.
"""
import importlib
import logging
import runpy
import sys
from datetime import date
from unittest.mock import MagicMock, patch

import pytest

MODULE = "health_data_hub.integrations.notion.notion_strava_sync"
TEMPLATE_ID = "260993b90201801e8a8cc4720b2234ef"
UPLOAD_ID = "upload-123"
FILE_URL = "https://files.example.invalid/peloton.png"

PELOTON_ROW = {
    "workout_id": 111,
    "name": "Peloton ride",
    "elevation_meters": 0,
    "sport_type": "VirtualRide",
    "workout_date": date(2026, 11, 10),
}
GARMIN_ROW = {**PELOTON_ROW, "workout_id": 222, "name": "Outdoor", "elevation_meters": 350}

FILE_TEMPLATE = {
    "id": TEMPLATE_ID,
    "icon": {"type": "file", "file": {"url": FILE_URL, "expiry_time": "2026-11-16T00:00:00Z"}},
}
EMOJI_TEMPLATE = {"id": TEMPLATE_ID, "icon": {"type": "emoji", "emoji": "\U0001F6B4"}}


class FakeResponse:
    def __init__(self, payload=None, content=b"PNGDATA"):
        self._payload = payload if payload is not None else {}
        self.content = content
        self.status_code = 200
        self.text = ""

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload

    def iter_content(self, chunk_size=1):
        yield self.content


class FakeRequests:
    def __init__(self, template, fail_get=False, fail_upload=False):
        self.template = template
        self.fail_get = fail_get
        self.fail_upload = fail_upload
        self.calls = []  # (method, url, kwargs)

    def _record(self, method, url, kwargs):
        self.calls.append((method, url, kwargs))

    def get(self, url, **kwargs):
        self._record("GET", url, kwargs)
        if TEMPLATE_ID in url.replace("-", ""):
            if self.fail_get:
                raise RuntimeError("template fetch boom")
            return FakeResponse(self.template)
        return FakeResponse({}, content=b"PNGDATA")

    def post(self, url, **kwargs):
        self._record("POST", url, kwargs)
        if "file_uploads" in url:
            if self.fail_upload:
                raise RuntimeError("upload boom")
            return FakeResponse({"id": UPLOAD_ID, "status": "pending"})
        return FakeResponse({})

    def patch(self, url, **kwargs):
        self._record("PATCH", url, kwargs)
        return FakeResponse({})

    def delete(self, url, **kwargs):
        self._record("DELETE", url, kwargs)
        return FakeResponse({})

    # helpers
    def template_gets(self):
        return [c for c in self.calls if c[0] == "GET" and TEMPLATE_ID in c[1].replace("-", "")]

    def uploads(self):
        return [c for c in self.calls if c[0] == "POST" and "file_uploads" in c[1]]

    def icon_patches(self):
        return [
            c for c in self.calls
            if c[0] == "PATCH" and isinstance(c[2].get("json"), dict) and "icon" in c[2]["json"]
        ]


def _load(monkeypatch, dry_run=False):
    monkeypatch.setenv("NOTION_TOKEN", "test-token")
    monkeypatch.setenv("NOTION_WORKOUT_DB_ID", "test-db")
    monkeypatch.setenv("NOTION_DRY_RUN", "1" if dry_run else "0")
    sys.modules.pop(MODULE, None)  # fresh module: resets any per-process cache
    return importlib.import_module(MODULE)


@pytest.fixture
def load(monkeypatch):
    def _do(template=FILE_TEMPLATE, dry_run=False, **fake_kwargs):
        mod = _load(monkeypatch, dry_run=dry_run)
        fake = FakeRequests(template, **fake_kwargs)
        monkeypatch.setattr(mod, "requests", fake)
        return mod, fake

    yield _do
    sys.modules.pop(MODULE, None)


def _notion(existing_page=None, new_id="new-page"):
    notion = MagicMock()
    notion.request.return_value = {"results": [existing_page] if existing_page else []}
    notion.pages.create.return_value = {"id": new_id}
    notion.pages.update.return_value = {"id": (existing_page or {}).get("id", "x")}
    return notion


def _assert_file_upload_icon(patch_call, page_id):
    method, url, kwargs = patch_call
    assert url.rstrip("/").endswith(f"/pages/{page_id}")
    assert kwargs["json"]["icon"] == {
        "type": "file_upload",
        "file_upload": {"id": UPLOAD_ID},
    }


def test_create_path_peloton_sets_template_icon(load):
    mod, fake = load()
    notion = _notion()
    page_id = mod.upsert_workout(notion, "test-db", PELOTON_ROW)
    assert page_id == "new-page"
    patches = fake.icon_patches()
    assert len(patches) == 1
    _assert_file_upload_icon(patches[0], "new-page")


@pytest.mark.parametrize("icon", [None])
def test_update_path_peloton_empty_icon_sets_template_icon(load, icon):
    mod, fake = load()
    existing = {"id": "page-1", "icon": icon, "properties": {}}
    notion = _notion(existing)
    page_id = mod.upsert_workout(notion, "test-db", PELOTON_ROW)
    assert page_id == "page-1"
    patches = fake.icon_patches()
    assert len(patches) == 1
    _assert_file_upload_icon(patches[0], "page-1")


@pytest.mark.parametrize(
    "icon",
    [
        {"type": "emoji", "emoji": "⭐"},
        {"type": "file", "file": {"url": "https://files.example.invalid/x.png"}},
        {"type": "external", "external": {"url": "https://example.invalid/i.png"}},
    ],
)
def test_update_path_existing_icon_is_left_alone(load, icon):
    mod, fake = load()
    existing = {"id": "page-1", "icon": icon, "properties": {}}
    page_id = mod.upsert_workout(_notion(existing), "test-db", PELOTON_ROW)
    assert page_id == "page-1"
    assert fake.icon_patches() == []
    assert fake.uploads() == []


def test_garmin_row_makes_no_icon_calls(load):
    mod, fake = load()
    page_id = mod.upsert_workout(_notion(), "test-db", GARMIN_ROW)
    assert page_id == "new-page"
    assert fake.template_gets() == []
    assert fake.uploads() == []
    assert fake.icon_patches() == []


def test_garmin_row_update_makes_no_icon_calls(load):
    mod, fake = load()
    existing = {"id": "page-2", "icon": None, "properties": {}}
    mod.upsert_workout(_notion(existing), "test-db", GARMIN_ROW)
    assert fake.template_gets() == []
    assert fake.uploads() == []
    assert fake.icon_patches() == []


def test_emoji_template_icon_is_copied_without_upload(load):
    mod, fake = load(template=EMOJI_TEMPLATE)
    mod.upsert_workout(_notion(), "test-db", PELOTON_ROW)
    assert fake.uploads() == []
    patches = fake.icon_patches()
    assert len(patches) == 1
    assert patches[0][2]["json"]["icon"] == {"type": "emoji", "emoji": "\U0001F6B4"}
    assert patches[0][1].rstrip("/").endswith("/pages/new-page")


def test_template_page_fetched_once_per_process(load):
    mod, fake = load()
    notion = _notion()
    mod.upsert_workout(notion, "test-db", PELOTON_ROW)
    mod.upsert_workout(notion, "test-db", {**PELOTON_ROW, "workout_id": 112})
    assert len(fake.template_gets()) == 1
    assert len(fake.icon_patches()) == 2


def test_template_fetch_failure_is_logged_and_page_id_returned(load, caplog):
    mod, fake = load(fail_get=True)
    with caplog.at_level(logging.DEBUG):
        page_id = mod.upsert_workout(_notion(), "test-db", PELOTON_ROW)
    assert page_id == "new-page"
    assert fake.icon_patches() == []
    assert any(r.levelno >= logging.WARNING for r in caplog.records)


def test_upload_failure_is_logged_and_page_id_returned(load, caplog):
    mod, fake = load(fail_upload=True)
    with caplog.at_level(logging.DEBUG):
        page_id = mod.upsert_workout(_notion(), "test-db", PELOTON_ROW)
    assert page_id == "new-page"
    assert fake.icon_patches() == []
    assert any(r.levelno >= logging.WARNING for r in caplog.records)


def test_dry_run_makes_no_icon_call(load):
    mod, fake = load(dry_run=True)
    mod.upsert_workout(_notion(), "test-db", PELOTON_ROW)
    assert fake.template_gets() == []
    assert fake.uploads() == []
    assert fake.icon_patches() == []


def test_main_since_flag_runs_sync_from_that_date(monkeypatch):
    monkeypatch.setenv("NOTION_TOKEN", "test-token")
    monkeypatch.setenv("NOTION_WORKOUT_DB_ID", "test-db")
    monkeypatch.setenv("NOTION_DRY_RUN", "0")
    monkeypatch.setattr(sys, "argv", ["notion_strava_sync", "--since", "2026-11-01"])

    cur = MagicMock()
    cur.fetchall.return_value = []
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur

    with patch("health_data_hub.utils.db_connect.get_connection", return_value=conn), \
         patch("health_data_hub.utils.logging_config.setup_logging"):
        runpy.run_module(MODULE, run_name="__main__")

    assert cur.execute.call_count >= 1
    params = cur.execute.call_args_list[0].args[1]
    assert tuple(params) == (date(2026, 11, 1),)
