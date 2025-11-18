# etl/extract/strava_streams.py

import os
import requests
from dotenv import load_dotenv
from .strava_refresh import refresh_access_token

load_dotenv("config/dev.env")

BASE_URL = "https://www.strava.com/api/v3"

STREAM_TYPES = [
    "time",
    "watts",
    "heartrate",
    "cadence",
    "velocity_smooth",   # speed in m/s
]


def get_streams(activity_id: int):
    """Fetch second-by-second streams for a Strava activity."""
    
    token = refresh_access_token()

    headers = {"Authorization": f"Bearer {token}"}

    params = {
        "keys": ",".join(STREAM_TYPES),
        "key_by_type": "true"
    }

    url = f"{BASE_URL}/activities/{activity_id}/streams"

    response = requests.get(url, headers=headers, params=params)

    if response.status_code != 200:
        raise Exception(f"Error fetching streams: {response.text}")

    data = response.json()

    # Ensure all expected keys exist
    streams = {}
    for s in STREAM_TYPES:
        streams[s] = data.get(s, {}).get("data", [])

    return streams
