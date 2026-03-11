"""
Refresh Strava OAuth access token using the stored refresh token.
"""

import json
import os
import requests

from health_data_hub.config.settings import (
    STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET,
    TOKEN_FILE,
)

TOKEN_URL = "https://www.strava.com/oauth/token"


def _load_token_file():
    """Load the current token payload safely."""
    if not TOKEN_FILE.exists():
        raise FileNotFoundError(f"Missing Strava token file: {TOKEN_FILE}")

    text = TOKEN_FILE.read_text(encoding="utf-8").strip()

    if not text:
        raise RuntimeError(
            f"Token file is empty: {TOKEN_FILE}. "
            "Re-run the Strava OAuth authorization flow."
        )

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Token file contains invalid JSON: {TOKEN_FILE}"
        ) from e

    if not isinstance(data, dict):
        raise RuntimeError(f"Token file did not contain a JSON object: {TOKEN_FILE}")

    return data


def _save_token_file(tokens):
    """Persist refreshed tokens atomically to avoid file corruption."""
    temp_file = TOKEN_FILE.with_suffix(".json.tmp")

    with open(temp_file, "w", encoding="utf-8") as f:
        json.dump(tokens, f, indent=2)
        f.flush()
        os.fsync(f.fileno())

    temp_file.replace(TOKEN_FILE)


def refresh_access_token():
    """
    Refresh the Strava access token and return the new token.
    """
    token_data = _load_token_file()

    refresh_token = token_data.get("refresh_token")
    if not refresh_token:
        raise RuntimeError("Refresh token missing from token file")

    payload = {
        "client_id": STRAVA_CLIENT_ID,
        "client_secret": STRAVA_CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }

    response = requests.post(TOKEN_URL, data=payload, timeout=30)

    print(f"[DEBUG refresh] status={response.status_code}")
    print(f"[DEBUG refresh] content-type={response.headers.get('Content-Type')}")
    print(f"[DEBUG refresh] body={response.text[:500]!r}")

    response.raise_for_status()

    try:
        tokens = response.json()
    except ValueError as e:
        raise RuntimeError(
            f"Refresh response was not valid JSON. "
            f"Status={response.status_code}, "
            f"Body={response.text[:500]!r}"
        ) from e

    access_token = tokens.get("access_token")
    if not access_token:
        raise RuntimeError(f"No access_token returned from Strava: {tokens}")

    _save_token_file(tokens)
    return access_token