"""
Sync the FTP and W/kg line charts to Datawrapper.

Builds the dataset (T1), writes the CSV, and when its SHA-256 differs from the
stored one (or chart IDs are missing) creates/styles/updates/publishes both
charts. Embed URL for Notion: https://datawrapper.dwcdn.net/<chart_id>/

Usage:
    python -m health_data_hub.integrations.datawrapper.ftp_wkg_charts [--dry-run]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import logging
import os
import sys
import tempfile
from pathlib import Path

import requests

from health_data_hub.config.settings import (
    DATAWRAPPER_API_TOKEN,
    DATAWRAPPER_STATE_FILE,
    FTP_WKG_CSV_PATH,
)
from health_data_hub.etl.transform.build_ftp_wkg import (
    build_rows,
    fetch_inputs,
    write_csv,
)
from health_data_hub.utils.db_connect import get_connection

logger = logging.getLogger(__name__)

API = "https://api.datawrapper.de/v3/charts"
TIMEOUT = 15


class ApiError(Exception):
    pass


def _headers(extra=None):
    h = {"Authorization": f"Bearer {DATAWRAPPER_API_TOKEN}"}
    if extra:
        h.update(extra)
    return h


def _call(method, url, **kw):
    try:
        resp = requests.request(method, url, headers=_headers(kw.pop("headers", None)),
                                timeout=TIMEOUT, **kw)
    except requests.RequestException as e:
        # exception text may embed request details; log only its type
        raise ApiError(f"{method} {url} failed: {type(e).__name__}") from None
    if not 200 <= resp.status_code < 300:
        logger.error("Datawrapper %s %s -> %d: %s", method, url,
                     resp.status_code, resp.text[:300])
        raise ApiError(f"{method} {url} returned {resp.status_code}")
    return resp


def _chart_csv(rows, key, header):
    buf = io.StringIO()
    wr = csv.writer(buf, lineterminator="\n")
    wr.writerow(["date", header])
    for r in rows:
        wr.writerow([r["date"].isoformat(), r[key]])
    return buf.getvalue()


def _ftp_annotations(rows):
    out, prev = [], None
    for r in rows:
        if prev is not None and r["ftp_w"] != prev:
            out.append({"x": r["date"].isoformat(), "y": r["ftp_w"],
                        "text": f"{r['ftp_w']} W"})
        prev = r["ftp_w"]
    return out


def _metadata(title, column, color, rows):
    visualize = {
        "custom-colors": {column: color},
        "y-grid": "off",
        "line-symbols": True,
        "line-symbols-on": "last",
    }
    if title == "FTP":
        visualize["interpolation"] = "step-after"
        visualize["text-annotations"] = _ftp_annotations(rows)
    return {
        "title": title,
        "metadata": {"visualize": visualize, "publish": {"autoDarkMode": True}},
    }


def _charts(rows):
    return {
        "ftp": dict(title="FTP", column="FTP (W)", color="#3B6EA8",
                    csv=_chart_csv(rows, "ftp_w", "FTP (W)")),
        "wkg": dict(title="Power-to-weight", column="W/kg", color="#E08A3C",
                    csv=_chart_csv(rows, "wkg", "W/kg")),
    }


def _load_state():
    try:
        with open(Path(DATAWRAPPER_STATE_FILE), encoding="utf-8") as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(state):
    path = Path(DATAWRAPPER_STATE_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def sync_once(dry_run: bool = False) -> int:
    """Returns 0 ok, 1 API/DB error, 2 token missing."""
    if not dry_run and not DATAWRAPPER_API_TOKEN:
        logger.error("DATAWRAPPER_API_TOKEN is not set")
        return 2

    try:
        conn = get_connection()
        try:
            ftp_rows, weight_rows = fetch_inputs(conn)
        finally:
            conn.close()
    except Exception as e:  # DB errors must not raise (poll_once convention)
        logger.error("Failed to read inputs: %s", e)
        return 1

    rows = build_rows(ftp_rows, weight_rows)
    csv_path = Path(FTP_WKG_CSV_PATH)
    try:
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        write_csv(rows, csv_path)
        digest = hashlib.sha256(csv_path.read_bytes()).hexdigest()
    except OSError as e:
        logger.error("Failed to write CSV: %s", e)
        return 1

    if dry_run:
        logger.info("[dry-run] wrote %d rows to %s (sha256 %s)", len(rows), csv_path, digest)
        return 0

    state = _load_state()
    ids = state.get("charts") or {}
    if state.get("csv_sha256") == digest and ids.get("ftp") and ids.get("wkg"):
        logger.info("CSV unchanged; nothing to sync")
        return 0

    charts = _charts(rows)
    try:
        for key, c in charts.items():
            if not ids.get(key):
                resp = _call("POST", API, json={"title": c["title"], "type": "d3-lines"})
                ids[key] = resp.json()["id"]
                state["charts"] = ids  # persist IDs at once so a retry never re-creates
                _save_state(state)
        for key, c in charts.items():
            cid = ids[key]
            _call("PATCH", f"{API}/{cid}",
                  json=_metadata(c["title"], c["column"], c["color"], rows))
            _call("PUT", f"{API}/{cid}/data", data=c["csv"].encode("utf-8"),
                  headers={"Content-Type": "text/csv"})
            _call("POST", f"{API}/{cid}/publish")
        state["charts"] = ids
        state["csv_sha256"] = digest
        _save_state(state)
    except (ApiError, KeyError, ValueError, OSError) as e:
        logger.error("Datawrapper sync failed: %s", e)
        return 1

    logger.info("Published charts: %s", ", ".join(
        f"https://datawrapper.dwcdn.net/{i}/" for i in ids.values()))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="write the CSV only; no Datawrapper calls")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    return sync_once(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
