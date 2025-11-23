import json
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "config" / "dev.env")

CLIENT_ID = os.getenv("STRAVA_CLIENT_ID")
CLIENT_SECRET = os.getenv("STRAVA_CLIENT_SECRET")
TOKEN_FILE = Path(__file__).resolve().parents[2] / "config" / "strava_tokens.json"


def refresh_access_token():
    # Read existing tokens
    with open(TOKEN_FILE, "r") as f:
        tokens = json.load(f)

    refresh_token = tokens["refresh_token"]

    # Request new token
    response = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
    )

    new_tokens = response.json()

    # Save new token data
    with open(TOKEN_FILE, "w") as f:
        json.dump(new_tokens, f, indent=4)

    print("Token refreshed successfully.")
    return new_tokens["access_token"]


if __name__ == "__main__":
    refresh_access_token()
