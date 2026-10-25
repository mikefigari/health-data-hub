"""sync_once must never raise (poll_once convention)."""
from unittest.mock import MagicMock

from health_data_hub.integrations.datawrapper import ftp_wkg_charts as m


def test_build_rows_typeerror_returns_1(monkeypatch):
    monkeypatch.setattr(m, "DATAWRAPPER_API_TOKEN", "x")
    monkeypatch.setattr(m, "get_connection", lambda: MagicMock())
    monkeypatch.setattr(m, "fetch_inputs", lambda conn: ([], []))

    def boom(*a, **k):
        raise TypeError("bad")

    monkeypatch.setattr(m, "build_rows", boom)
    assert m.sync_once(dry_run=True) == 1
