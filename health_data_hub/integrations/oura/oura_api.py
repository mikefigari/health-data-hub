import os
import requests
from pathlib import Path
from dotenv import load_dotenv




# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------

def get_oura_auth_header():
    token = os.getenv("OURA_PERSONAL_ACCESS_TOKEN")
    if not token:
        raise Exception("Missing OURA_PERSONAL_ACCESS_TOKEN in dev.env")
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Base URL
# ---------------------------------------------------------------------------

BASE_URL = "https://api.ouraring.com/v2/usercollection"


# ---------------------------------------------------------------------------
# Generic GET helper
# ---------------------------------------------------------------------------

def _get(endpoint: str, params: dict):
    headers = get_oura_auth_header()
    url = f"{BASE_URL}/{endpoint}"
    resp = requests.get(url, headers=headers, params=params)

    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Sleep
# ---------------------------------------------------------------------------

def fetch_sleep(start_date: str, end_date: str):
    """
    Fetch sleep data.
    """
    return _get("sleep", {
        "start_date": start_date,
        "end_date": end_date
    })


# ---------------------------------------------------------------------------
# Daily Activity (steps, calories, inactivity, etc.)
# ---------------------------------------------------------------------------

def fetch_activity(start_date: str, end_date: str):
    """
    Fetch daily activity summary.
    """
    return _get("daily_activity", {
        "start_date": start_date,
        "end_date": end_date
    })
