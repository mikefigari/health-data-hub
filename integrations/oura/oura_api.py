import os
import requests
from dotenv import load_dotenv
from pathlib import Path

# Load env
load_dotenv(Path(__file__).resolve().parents[2] / "config" / "dev.env")

BASE_URL = "https://api.ouraring.com/v2/usercollection"

def get_oura_auth_header():
    token = os.getenv("OURA_PERSONAL_ACCESS_TOKEN")
    if not token:
        raise Exception("Missing OURA_PERSONAL_ACCESS_TOKEN in dev.env")
    return {"Authorization": f"Bearer {token}"}

def fetch_sleep(start_date: str, end_date: str):
    """Fetch sleep data from Oura API."""
    url = f"{BASE_URL}/sleep"
    headers = get_oura_auth_header()
    params = {"start_date": start_date, "end_date": end_date}

    resp = requests.get(url, headers=headers, params=params)
    resp.raise_for_status()
    return resp.json()
