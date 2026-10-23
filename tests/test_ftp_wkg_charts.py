"""
Unit tests for health_data_hub.integrations.datawrapper.ftp_wkg_charts.sync_once.

HTTP is intercepted at requests.Session.request (covers requests.get/post/put/
patch/request and Session use); the adapter is blocked as a second guard.
get_connection is patched to a fake connection that serves ftp_history and
body_weight_daily rows to T1's fetch_inputs. No network, no database.

The state file format is not pinned: tests only check that it contains both
chart IDs and the CSV's SHA-256, and drive later runs through sync_once itself.

Run:
    pytest tests/test_ftp_wkg_charts.py -v
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import os
import runpy
import sys
from collections import Counter
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests
from requests.structures import CaseInsensitiveDict

from health_data_hub.config import settings
from health_data_hub.etl.transform import build_ftp_wkg as b
from health_data_hub.integrations.datawrapper import ftp_wkg_charts as m
from health_data_hub.utils import db_connect

MODULE = "health_data_hub.integrations.datawrapper.ftp_wkg_charts"
BASE = "https://api.datawrapper.de/v3/charts"
TOKEN = "dw-secret-token-7f3a9c41"

FTP_ROWS = [(date(2024, 1, 1), 200), (date(2024, 6, 1), 220), (date(2024, 9, 1), 235)]
WEIGHT_ROWS = [
    (date(2024, 1, 1), 80.0),
    (date(2024, 3, 1), 79.0),
    (date(2024, 6, 15), 78.0),
    (date(2024, 9, 10), 77.5),
]


# ---------------------------------------------------------------- fakes


class Call:
    def __init__(self, method, url, kind, chart_id, headers, body, timeout):
        self.method = method
        self.url = url
        self.kind = kind
        self.chart_id = chart_id
        self.headers = headers
        self.body = body
        self.timeout = timeout


def classify(method, url):
    u = url.split("?")[0].rstrip("/")
    if method == "POST" and u == BASE:
        return "create", None
    if u.startswith(BASE + "/"):
        parts = u[len(BASE) + 1:].split("/")
        cid, rest = parts[0], parts[1:]
        if method == "PATCH" and rest == []:
            return "patch", cid
        if method == "PUT" and rest == ["data"]:
            return "data", cid
        if method == "POST" and rest == ["publish"]:
            return "publish", cid
    return "other", None


def make_response(status, body, url):
    r = requests.Response()
    r.status_code = status
    r.url = url
    r.encoding = "utf-8"
    if body is None:
        r._content = b""
    else:
        r._content = json.dumps(body).encode("utf-8")
        r.headers["Content-Type"] = "application/json"
    return r


class FakeDatawrapper:
    def __init__(self):
        self.calls = []
        self.fail_kind = None
        self._n = 0

    def handle(self, session, method, url, *args, **kw):
        # Session.request(method, url, params, data, headers, ...) positional fallbacks
        names = ["params", "data", "headers"]
        for name, val in zip(names, args):
            kw.setdefault(name, val)
        method = str(method).upper()
        headers = CaseInsensitiveDict(dict(getattr(session, "headers", {}) or {}))
        headers.update(kw.get("headers") or {})
        if kw.get("json") is not None:
            body = kw["json"]
        else:
            body = kw.get("data")
            if isinstance(body, bytes):
                body = body.decode("utf-8")
        kind, cid = classify(method, url)
        call = Call(method, url, kind, cid, headers, body, kw.get("timeout"))
        self.calls.append(call)

        if self.fail_kind == kind:
            return make_response(500, {"message": "Internal Server Error"}, url)
        if kind == "create":
            self._n += 1
            call.chart_id = f"Ch{self._n:03d}"
            return make_response(201, {"id": call.chart_id, "type": "d3-lines"}, url)
        if kind == "data":
            return make_response(204, None, url)
        if kind == "publish":
            return make_response(200, {"data": {"id": cid}, "version": 1}, url)
        return make_response(200, {"id": cid}, url)

    def of(self, kind):
        return [c for c in self.calls if c.kind == kind]


class FakeCursor:
    def __init__(self, data):
        self.data = data
        self.sql = ""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, *args, **kwargs):
        self.sql = str(sql)

    def fetchall(self):
        if "ftp_history" in self.sql:
            return list(self.data["ftp"])
        if "body_weight_daily" in self.sql:
            return list(self.data["weights"])
        return []

    def close(self):
        pass


@pytest.fixture
def env(tmp_path, monkeypatch):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    state = state_dir / "datawrapper_charts.json"
    csv_path = tmp_path / "exports" / "ftp_wkg.csv"  # parent does not exist yet

    for name, val in (
        ("DATAWRAPPER_API_TOKEN", TOKEN),
        ("DATAWRAPPER_STATE_FILE", state),
        ("FTP_WKG_CSV_PATH", csv_path),
    ):
        monkeypatch.setattr(settings, name, val)
        monkeypatch.setattr(m, name, val, raising=False)

    data = {"ftp": list(FTP_ROWS), "weights": list(WEIGHT_ROWS)}
    conn = MagicMock()
    conn.cursor.side_effect = lambda *a, **k: FakeCursor(data)
    conn.__enter__.return_value = conn
    get_conn = MagicMock(return_value=conn)
    monkeypatch.setattr(db_connect, "get_connection", get_conn)
    monkeypatch.setattr(m, "get_connection", get_conn, raising=False)

    dw = FakeDatawrapper()

    def _request(session, method, url, *args, **kw):
        return dw.handle(session, method, url, *args, **kw)

    def _blocked_send(*a, **k):
        raise AssertionError("real network access attempted")

    monkeypatch.setattr(requests.sessions.Session, "request", _request)
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", _blocked_send)

    return {"state": state, "csv": csv_path, "data": data, "dw": dw, "conn": conn}


# ---------------------------------------------------------------- helpers


def csv_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def state_text(env):
    p = env["state"]
    return p.read_text(encoding="utf-8") if p.exists() else ""


def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def patch_bodies(dw):
    """Merged PATCH body per chart id."""
    out = {}
    for c in dw.of("patch"):
        body = c.body if isinstance(c.body, dict) else json.loads(c.body)
        deep_merge(out.setdefault(c.chart_id, {}), body)
    return out


def ids_by_title(dw):
    return {body.get("title"): cid for cid, body in patch_bodies(dw).items()}


def data_csv(dw, chart_id):
    puts = [c for c in dw.of("data") if c.chart_id == chart_id]
    assert puts, f"no PUT data for chart {chart_id}"
    text = puts[-1].body
    return list(csv.reader(io.StringIO(text)))


def change_data(env):
    env["data"]["weights"].append((date(2024, 10, 1), 77.0))


# ---------------------------------------------------------------- tests


@pytest.mark.parametrize("token", [None, ""])
def test_a_token_unset_returns_2_and_makes_no_http_calls(env, monkeypatch, token):
    monkeypatch.setattr(settings, "DATAWRAPPER_API_TOKEN", token)
    monkeypatch.setattr(m, "DATAWRAPPER_API_TOKEN", token, raising=False)
    assert m.sync_once() == 2
    assert env["dw"].calls == []


def test_b_first_run_creates_two_charts_then_patch_put_publish(env):
    dw = env["dw"]
    assert m.sync_once() == 0

    creates = dw.of("create")
    assert len(creates) == 2
    for c in creates:
        body = c.body if isinstance(c.body, dict) else json.loads(c.body)
        assert body["type"] == "d3-lines"
    ids = [c.chart_id for c in creates]
    assert len(set(ids)) == 2

    for cid in ids:
        idx = {k: [i for i, c in enumerate(dw.calls) if c.kind == k and c.chart_id == cid]
               for k in ("patch", "data", "publish")}
        assert idx["patch"], f"no PATCH for {cid}"
        assert idx["data"], f"no PUT data for {cid}"
        assert len(idx["publish"]) == 1, f"expected one publish for {cid}"
        create_idx = dw.calls.index(next(c for c in creates if c.chart_id == cid))
        assert create_idx < min(idx["patch"])
        assert max(idx["patch"]) < idx["publish"][0]
        assert max(idx["data"]) < idx["publish"][0]

    for c in dw.calls:
        assert c.headers.get("Authorization") == f"Bearer {TOKEN}"
        assert c.timeout == 15

    assert env["csv"].exists()
    text = state_text(env)
    assert text, "state file not written"
    json.loads(text)
    for cid in ids:
        assert cid in text
    assert csv_hash(env["csv"]) in text


def test_c_second_run_with_unchanged_data_makes_zero_http_calls(env):
    assert m.sync_once() == 0
    env["dw"].calls.clear()
    assert m.sync_once() == 0
    assert env["dw"].calls == []


def test_d_changed_data_with_existing_ids_puts_and_publishes_without_create(env):
    dw = env["dw"]
    assert m.sync_once() == 0
    ids = {c.chart_id for c in dw.of("create")}
    old_hash = csv_hash(env["csv"])

    change_data(env)
    dw.calls.clear()
    assert m.sync_once() == 0

    assert dw.of("create") == []
    assert {c.chart_id for c in dw.of("data")} == ids
    assert {c.chart_id for c in dw.of("publish")} == ids
    for cid in ids:
        assert len([c for c in dw.of("publish") if c.chart_id == cid]) == 1
        pub = dw.calls.index(next(c for c in dw.of("publish") if c.chart_id == cid))
        last_put = max(i for i, c in enumerate(dw.calls) if c.kind == "data" and c.chart_id == cid)
        assert last_put < pub

    new_hash = csv_hash(env["csv"])
    assert new_hash != old_hash
    assert new_hash in state_text(env)


def test_e_chart_csvs_have_expected_columns_and_shared_dates(env):
    dw = env["dw"]
    assert m.sync_once() == 0
    titles = ids_by_title(dw)
    ftp = data_csv(dw, titles["FTP"])
    wkg = data_csv(dw, titles["Power-to-weight"])

    assert ftp[0] == ["date", "FTP (W)"]
    assert wkg[0] == ["date", "W/kg"]
    ftp_dates = [r[0] for r in ftp[1:] if r]
    wkg_dates = [r[0] for r in wkg[1:] if r]
    assert ftp_dates == wkg_dates

    rows = b.build_rows(FTP_ROWS, WEIGHT_ROWS)
    assert ftp_dates == [r["date"].isoformat() for r in rows]
    for line, r in zip([x for x in ftp[1:] if x], rows):
        assert float(line[1]) == pytest.approx(float(r["ftp_w"]))
    for line, r in zip([x for x in wkg[1:] if x], rows):
        assert float(line[1]) == pytest.approx(float(r["wkg"]))


def test_e_put_data_is_sent_as_text_csv(env):
    assert m.sync_once() == 0
    for c in env["dw"].of("data"):
        assert "text/csv" in (c.headers.get("Content-Type") or "").lower()


def test_f_patch_metadata_styles_both_charts(env):
    dw = env["dw"]
    assert m.sync_once() == 0
    bodies = patch_bodies(dw)
    titles = ids_by_title(dw)
    assert set(titles) == {"FTP", "Power-to-weight"}

    ftp = bodies[titles["FTP"]]
    wkg = bodies[titles["Power-to-weight"]]

    for body, col, color in ((ftp, "FTP (W)", "#3b6ea8"), (wkg, "W/kg", "#e08a3c")):
        meta = body["metadata"]
        vis = meta["visualize"]
        assert vis["custom-colors"][col].lower() == color
        assert vis["y-grid"] == "off"
        assert vis["line-symbols"] is True
        assert vis["line-symbols-on"] == "last"
        assert meta["publish"]["autoDarkMode"] is True

    fvis = ftp["metadata"]["visualize"]
    assert fvis["interpolation"] == "step-after"

    labels = Counter(a["text"] for a in fvis["text-annotations"])
    # "one entry per FTP change": with or without the initial FTP level
    with_initial = Counter(["200 W", "220 W", "235 W"])
    changes_only = Counter(["220 W", "235 W"])
    assert labels in (with_initial, changes_only), labels


@pytest.mark.parametrize("kind", ["create", "patch", "data", "publish"])
def test_g_500_on_first_run_returns_1_without_storing_hash(env, caplog, capsys, kind):
    caplog.set_level(logging.DEBUG)
    dw = env["dw"]
    dw.fail_kind = kind
    assert m.sync_once() == 1

    assert csv_hash(env["csv"]) not in state_text(env)
    out = capsys.readouterr()
    assert TOKEN not in caplog.text
    assert TOKEN not in out.out + out.err

    # hash was not stored, so the next clean run must sync again
    dw.fail_kind = None
    dw.calls.clear()
    assert m.sync_once() == 0
    assert dw.of("publish")
    assert csv_hash(env["csv"]) in state_text(env)


@pytest.mark.parametrize("kind", ["patch", "data", "publish"])
def test_g_500_on_changed_data_keeps_old_hash(env, caplog, capsys, kind):
    caplog.set_level(logging.DEBUG)
    dw = env["dw"]
    assert m.sync_once() == 0
    old_hash = csv_hash(env["csv"])

    change_data(env)
    dw.fail_kind = kind
    assert m.sync_once() == 1
    new_hash = csv_hash(env["csv"])
    assert new_hash != old_hash

    text = state_text(env)
    assert old_hash in text
    assert new_hash not in text
    out = capsys.readouterr()
    assert TOKEN not in caplog.text
    assert TOKEN not in out.out + out.err


def test_h_state_file_written_atomically(env, monkeypatch):
    real_replace = os.replace
    seen = []

    def spy(src, dst, *a, **k):
        seen.append((Path(src), Path(dst)))
        return real_replace(src, dst, *a, **k)

    monkeypatch.setattr(os, "replace", spy)
    assert m.sync_once() == 0

    state = env["state"].resolve()
    hits = [(s, d) for s, d in seen if d.resolve() == state]
    assert hits, "state file was not written via os.replace"
    src, _ = hits[-1]
    assert src.resolve() != state
    assert src.resolve().parent == state.parent  # same dir => same filesystem
    assert not src.exists()
    assert sorted(p.name for p in state.parent.iterdir()) == [state.name]


def test_i_cli_dry_run_writes_csv_and_makes_zero_http_calls(env, monkeypatch):
    monkeypatch.setattr(sys, "argv", [MODULE, "--dry-run"])
    code = 0
    try:
        runpy.run_module(MODULE, run_name="__main__", alter_sys=False)
    except SystemExit as e:
        code = e.code
    assert code in (0, None)

    assert env["dw"].calls == []
    assert env["csv"].exists()
    expected = b.to_csv(b.build_rows(FTP_ROWS, WEIGHT_ROWS))
    assert env["csv"].read_text(encoding="utf-8") == expected
