"""Build the FTP / weight / W-kg dataset used by the Datawrapper charts."""

from __future__ import annotations

import bisect
import csv
import io
from datetime import date

HEADER = ["date", "ftp_w", "weight_kg", "wkg", "weight_source"]

_FTP_SQL = (
    "SELECT (effective_from AT TIME ZONE 'America/Los_Angeles')::date, ftp_watts "
    "FROM ftp_history ORDER BY effective_from"
)
_WEIGHT_SQL = (
    "SELECT day, weight_kg FROM body_weight_daily "
    "WHERE weight_kg IS NOT NULL ORDER BY day"
)


def fetch_inputs(conn):
    """Return (ftp_rows, weight_rows) as lists of (date, number) tuples."""
    with conn.cursor() as cur:
        cur.execute(_FTP_SQL)
        ftp_rows = [(d, w) for d, w in cur.fetchall()]
        cur.execute(_WEIGHT_SQL)
        weight_rows = [(d, w) for d, w in cur.fetchall()]
    return ftp_rows, weight_rows


def _num(v):
    f = float(v)
    return int(f) if f == int(f) else f


def build_rows(ftp_rows, weight_rows):
    if not ftp_rows:
        return []
    ftps = sorted((d, _num(w)) for d, w in ftp_rows)
    ftp_dates = [d for d, _ in ftps]
    first = ftp_dates[0]
    weights = {}
    for d, w in weight_rows:
        weights[d] = float(w)
    wdates = sorted(weights)

    def ftp_for(d):
        return ftps[bisect.bisect_right(ftp_dates, d) - 1][1]

    def weight_at(d):
        if d in weights:
            return weights[d], "measured"
        i = bisect.bisect_left(wdates, d)
        prev = wdates[i - 1] if i > 0 else None
        nxt = wdates[i] if i < len(wdates) else None
        if prev is not None and nxt is not None:
            w0, w1 = weights[prev], weights[nxt]
            frac = (d - prev).days / (nxt - prev).days
            return w0 + (w1 - w0) * frac, "interpolated"
        if prev is not None:
            return weights[prev], "nearest"
        if nxt is not None:
            return weights[nxt], "nearest"
        return None, None

    days = {d for d in wdates if d >= first} | set(ftp_dates)
    rows = []
    for d in sorted(days):
        w, src = weight_at(d)
        if w is None:
            continue  # no weights at all; nothing to chart for this date
        ftp_w = ftp_for(d)
        rows.append(
            {
                "date": d,
                "ftp_w": ftp_w,
                "weight_kg": round(w, 2),
                "wkg": round(ftp_w / w, 2),
                "weight_source": src,
            }
        )
    return rows


def to_csv(rows):
    buf = io.StringIO()
    wr = csv.writer(buf, lineterminator="\n")
    wr.writerow(HEADER)
    for r in rows:
        d = r["date"]
        wr.writerow(
            [
                d.isoformat() if isinstance(d, date) else d,
                r["ftp_w"],
                r["weight_kg"],
                r["wkg"],
                r["weight_source"],
            ]
        )
    return buf.getvalue()


def write_csv(rows, path):
    with open(path, "w", newline="", encoding="utf-8") as f:
        f.write(to_csv(rows))
