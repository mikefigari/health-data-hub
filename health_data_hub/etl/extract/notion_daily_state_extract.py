"""
Extraction helpers for Notion Daily Physical State pages.
Pure transformation — no I/O. Converts raw Notion page objects
into clean dicts matching the daily_physical_state schema.
"""

from datetime import datetime
from typing import List, Dict, Any


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_select(props: dict, key: str):
    """Return the name of a select property, or None."""
    try:
        return props[key]["select"]["name"]
    except (KeyError, TypeError):
        return None


def _safe_rich_text(props: dict, key: str):
    """Join all plain_text items of a rich_text property, or return None."""
    try:
        parts = [t["plain_text"] for t in props[key]["rich_text"]]
        return "".join(parts) or None
    except (KeyError, TypeError):
        return None


def _parse_ts(ts: str | None):
    """Return a proper datetime or None."""
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def extract_daily_state_records(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Convert raw Notion page objects into row dicts for daily_physical_state.
    """
    results = []

    for page in pages:
        props = page.get("properties", {})

        # day is derived from created_time
        created_time = page.get("created_time", "")
        day = created_time[:10] if created_time else None

        body_signals_raw = []
        try:
            body_signals_raw = [
                i["name"] for i in props["Body Signals"]["multi_select"]
            ]
        except (KeyError, TypeError):
            pass

        results.append({
            "day": day,
            "notion_page_id": page.get("id"),
            "overall_state": _safe_select(props, "Overall State"),
            "energy_level": _safe_select(props, "Energy Level"),
            "body_signals": body_signals_raw or None,
            "notes": _safe_rich_text(props, "Notes"),
            "source": _safe_select(props, "Source"),
            "entry_confidence": _safe_select(props, "Entry Confidence"),
            "created_at": _parse_ts(created_time),
            "updated_at": _parse_ts(page.get("last_edited_time")),
        })

    return results
