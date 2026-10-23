"""
Unit tests for health_data_hub.integrations.apple_health.body_poller.poll_once.

requests.get and get_connection are patched: no network, no database.

Run:
    pytest tests/test_body_poller.py -v
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests

from health_data_hub.integrations.apple_health import body_poller

FIXTURE = Path(__file__).parent / "fixtures" / "hae_body_sample.json"


def fake_response(status, body=None):
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = body if body is not None else {}
    resp.text = json.dumps(body) if body is not None else ""
    return resp


@pytest.fixture
def patched(monkeypatch):
    """Patch config, requests.get, get_connection and the loader; return the mocks."""
    monkeypatch.setattr(body_poller, "HEALTH_WORKER_URL", "https://worker.example.test/health/")
    monkeypatch.setattr(body_poller, "HEALTH_TOKEN", "test-token")
    mocks = {
        "get": MagicMock(),
        "conn": MagicMock(),
        "get_connection": MagicMock(),
        "insert": MagicMock(return_value=3),
    }
    mocks["get_connection"].return_value = mocks["conn"]
    monkeypatch.setattr(body_poller.requests, "get", mocks["get"])
    monkeypatch.setattr(body_poller, "get_connection", mocks["get_connection"])
    monkeypatch.setattr(body_poller, "insert_body_measurements", mocks["insert"])
    return mocks


def fixture_payloads():
    metrics = json.loads(FIXTURE.read_text())["data"]["metrics"]
    return {"payloads": [{"key": "body:2026-10-21T05:00:00.000Z:abcd1234",
                          "received_at": "2026-10-21T05:00:00.000Z",
                          "metrics": metrics}]}


def test_200_with_payloads_upserts_and_returns_0(patched):
    patched["get"].return_value = fake_response(200, fixture_payloads())
    assert body_poller.poll_once(days_back=10) == 0

    args, kwargs = patched["get"].call_args
    assert args[0] == "https://worker.example.test/health/body"
    assert "since" in kwargs["params"]
    assert kwargs["headers"] == {"X-Health-Token": "test-token"}
    assert kwargs["timeout"] == 15

    patched["insert"].assert_called_once()
    conn_arg, rows = patched["insert"].call_args[0]
    assert conn_arg is patched["conn"]
    assert len(rows) == 3
    patched["conn"].close.assert_called_once()


def test_200_empty_list_returns_0(patched):
    patched["get"].return_value = fake_response(200, {"payloads": []})
    assert body_poller.poll_once() == 0
    patched["get_connection"].assert_not_called()


def test_404_returns_0(patched):
    patched["get"].return_value = fake_response(404, {"error": "not found"})
    assert body_poller.poll_once() == 0
    patched["get_connection"].assert_not_called()


def test_500_returns_1(patched):
    patched["get"].return_value = fake_response(500, {"error": "boom"})
    assert body_poller.poll_once() == 1
    patched["get_connection"].assert_not_called()


def test_request_exception_returns_1(patched):
    patched["get"].side_effect = requests.ConnectionError("down")
    assert body_poller.poll_once() == 1
    patched["get_connection"].assert_not_called()


def test_db_error_returns_1_and_closes(patched):
    import psycopg2
    patched["get"].return_value = fake_response(200, fixture_payloads())
    patched["insert"].side_effect = psycopg2.OperationalError("db down")
    assert body_poller.poll_once() == 1
    patched["conn"].close.assert_called_once()


def test_dry_run_never_opens_db(patched):
    patched["get"].return_value = fake_response(200, fixture_payloads())
    assert body_poller.poll_once(dry_run=True) == 0
    patched["get_connection"].assert_not_called()
    patched["insert"].assert_not_called()
