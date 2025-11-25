"""
Refresh Strava OAuth access token using stored refresh token.
"""

import json
from pathlib import Path
import requests

from health_data_hub.config.settings import (
    STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET,
)

# Where we persist the rotating Strava tokens
TOKEN_FILE = Path(__file__).resolve().parents[2] / "health_data_hub" / "config" / "strava_tokens.json"


def refresh_access_token() -> str:
    """
    Refresh the OAuth access token and return it.
    """
    if not TOKEN_FILE.exists():
        raise FileNotFoundError(f"Missing Strava token file: {TOKEN_FILE}")

    with TOKEN_FILE.open("r") as f:
        data = json.load(f)

    refresh_token = data.get("refresh_token")
    if not refresh_token:
        raise RuntimeError("Strava refresh_token missing in strava_tokens.json")

    response = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": STRAVA_CLIENT_ID,
            "client_secret": STRAVA_CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
    )

    response.raise_for_status()
    tokens = response.json()

    # Persist new tokens
    with TOKEN_FILE.open("w") as f:
        json.dump(tokens, f, indent=2)

    return tokens["access_token"]
