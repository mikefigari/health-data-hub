"""Link cycling rides to the Power Zone week page covering their LA date.

When a ride falls in a week newer than the newest Power Zone page, the next
week page is created from the template page (see `find_or_create_week_page`).
"""
from __future__ import annotations

import logging
import os
import re
from datetime import date, datetime, timedelta

import requests

from health_data_hub.config.settings import (
    NOTION_POWERZONE_DATE_PROP,
    NOTION_POWERZONE_DB_ID,
)
from health_data_hub.utils.db_connect import get_connection

logger = logging.getLogger(__name__)

NOTION_API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"
POWERZONE_TEMPLATE_PAGE_ID = "171993b9020180f9a6bef0bff3e21c1e"
STAR_EMOJI = "⭐"
QUESTION_ICON = {"type": "emoji", "emoji": "❓"}

# {week_start (Monday): powerzone page id}
_week_cache: dict[date, str] = {}


def week_bounds(d: date) -> tuple[date, date]:
    """Monday and Sunday of the week containing d."""
    monday = d - timedelta(days=d.weekday())
    return monday, monday + timedelta(days=6)


def next_week_label(labels: list[str]) -> str:
    """'Week N+1' where N is the highest 'Week N' in labels, else 'Week 1'."""
    highest = 0
    for label in labels:
        m = re.search(r"Week (\d+)", label or "")
        if m:
            highest = max(highest, int(m.group(1)))
    return f"Week {highest + 1}"


def ride_local_date(workout_id: int, fallback: date) -> date:
    """Ride start date in America/Los_Angeles, falling back to `fallback`."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date
                FROM workout_summary
                WHERE workout_id = %s
                """,
                (workout_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()
    if row is None or row[0] is None:
        return fallback
    return row[0]


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {os.getenv('NOTION_TOKEN')}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def _query(body: dict) -> dict:
    resp = requests.post(
        f"{NOTION_API_BASE}/databases/{NOTION_POWERZONE_DB_ID}/query",
        headers=_headers(),
        json=body,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def _query_all(body: dict) -> list:
    results: list = []
    body = {**body, "page_size": 100}
    while True:
        data = _query(body)
        results.extend(data.get("results", []))
        if not data.get("has_more"):
            return results
        body = {**body, "start_cursor": data.get("next_cursor")}


def _range(page: dict) -> tuple[date | None, date | None]:
    prop = (page.get("properties") or {}).get(NOTION_POWERZONE_DATE_PROP) or {}
    rng = prop.get("date") or {}
    start = rng.get("start")
    end = rng.get("end") or start
    to_date = lambda s: date.fromisoformat(s[:10]) if s else None  # noqa: E731
    return to_date(start), to_date(end)


def _plain(prop: dict | None, kind: str) -> str:
    items = (prop or {}).get(kind) or []
    return "".join(i.get("plain_text") or (i.get("text") or {}).get("content", "") for i in items)


def _icon_is_star(icon: dict | None) -> bool:
    return bool(icon) and icon.get("type") == "emoji" and icon.get("emoji") == STAR_EMOJI


def _create_week_page(week_start: date, week_end: date) -> str:
    tmpl_resp = requests.get(
        f"{NOTION_API_BASE}/pages/{POWERZONE_TEMPLATE_PAGE_ID}",
        headers=_headers(),
        timeout=30,
    )
    tmpl_resp.raise_for_status()
    tmpl = tmpl_resp.json()
    program = _plain((tmpl.get("properties") or {}).get("Program Name"), "title")

    same_program = _query_all({
        "filter": {"property": "Program Name", "title": {"equals": program}},
    })
    label = next_week_label(
        [_plain((p.get("properties") or {}).get("Week #"), "rich_text") for p in same_program]
    )

    # Earlier pages, newest first: FTP carry-over and star handoff.
    earlier = _query_all({
        "filter": {"property": NOTION_POWERZONE_DATE_PROP, "date": {"on_or_before": str(week_start)}},
        "sorts": [{"property": NOTION_POWERZONE_DATE_PROP, "direction": "descending"}],
    })
    earlier = [p for p in earlier if (_range(p)[0] or week_start) < week_start]
    ftp = None
    for p in earlier:
        value = ((p.get("properties") or {}).get("FTP") or {}).get("number")
        if value is not None:
            ftp = value
            break

    props: dict = {
        "Program Name": {"title": [{"text": {"content": program}}]},
        NOTION_POWERZONE_DATE_PROP: {"date": {"start": str(week_start), "end": str(week_end)}},
        "Week #": {"rich_text": [{"text": {"content": label}}]},
    }
    if ftp is not None:
        props["FTP"] = {"number": ftp}

    payload: dict = {"parent": {"database_id": NOTION_POWERZONE_DB_ID}, "properties": props}
    icon = tmpl.get("icon")
    if icon and icon.get("type") in ("emoji", "external"):
        payload["icon"] = icon
    cover = tmpl.get("cover")
    if cover and cover.get("type") == "external":
        payload["cover"] = cover

    resp = requests.post(f"{NOTION_API_BASE}/pages", headers=_headers(), json=payload, timeout=30)
    resp.raise_for_status()
    new_id = resp.json()["id"]
    logger.info(f"[Notion] Created PowerZone page {label} ({program}) for week {week_start}")

    for p in earlier:
        if not _icon_is_star(p.get("icon")):
            continue
        try:
            r = requests.patch(
                f"{NOTION_API_BASE}/pages/{p['id']}",
                headers=_headers(),
                json={"icon": QUESTION_ICON},
                timeout=30,
            )
            r.raise_for_status()
        except Exception as exc:
            logger.warning(f"[Notion] Could not update PowerZone icon on {p['id']}: {exc}")
    return new_id


def find_or_create_week_page(ride_date: date | datetime) -> str | None:
    """PowerZone page id covering ride_date; creates the next week if the ride is newer."""
    if not NOTION_POWERZONE_DB_ID:
        logger.info("[Notion] NOTION_POWERZONE_DB_ID not set - skipping PowerZone link.")
        return None
    if isinstance(ride_date, datetime):
        ride_date = ride_date.date()

    week_start, week_end = week_bounds(ride_date)
    cached = _week_cache.get(week_start)
    if cached:
        return cached

    date_prop = NOTION_POWERZONE_DATE_PROP
    results = _query({
        "filter": {"property": date_prop, "date": {"on_or_before": str(ride_date)}},
        "sorts": [{"property": date_prop, "direction": "descending"}],
        "page_size": 1,
    }).get("results", [])
    if results:
        start, end = _range(results[0])
        if start and end and start <= ride_date <= end:
            _week_cache[week_start] = results[0]["id"]
            return results[0]["id"]

    newest = _query({
        "sorts": [{"property": date_prop, "direction": "descending"}],
        "page_size": 1,
    }).get("results", [])
    newest_start = _range(newest[0])[0] if newest else None
    if newest_start is None or week_start <= week_bounds(newest_start)[0]:
        logger.info(f"[Notion] No PowerZone page covers {ride_date}; leaving ride unlinked.")
        return None

    new_id = _create_week_page(week_start, week_end)
    _week_cache[week_start] = new_id
    return new_id
