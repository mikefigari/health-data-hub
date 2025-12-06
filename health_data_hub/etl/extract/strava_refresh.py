"""
Refresh Strava OAuth access token using stored refresh token.
"""

import json
import requests
from pathlib import Path
from health_data_hub.config.settings import (
    STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET,
    TOKEN_FILE,
)

# Where we persist the rotating Strava tokens
from health_data_hub.config.settings import TOKEN_FILE



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
