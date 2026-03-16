"""
Oura API client. Auth token sourced from centralized settings,
which respects the HEALTH_ENV environment variable (dev/prod).
"""

import requests

from health_data_hub.config.settings import OURA_PERSONAL_ACCESS_TOKEN

BASE_URL = "https://api.ouraring.com/v2/usercollection"


def _auth_header():
    if not OURA_PERSONAL_ACCESS_TOKEN:
        raise RuntimeError(
            "Missing OURA_PERSONAL_ACCESS_TOKEN. "
            "Check your environment config file."
        )
    return {"Authorization": f"Bearer {OURA_PERSONAL_ACCESS_TOKEN}"}


def _get(endpoint: str, params: dict):
    response = requests.get(
        f"{BASE_URL}/{endpoint}",
        headers=_auth_header(),
        params=params,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def fetch_sleep(start_date: str, end_date: str):
    """Fetch sleep records for the given date range."""
    return _get("sleep", {"start_date": start_date, "end_date": end_date})


def fetch_activity(start_date: str, end_date: str):
    """Fetch daily activity summaries for the given date range."""
    return _get("daily_activity", {"start_date": start_date, "end_date": end_date})
