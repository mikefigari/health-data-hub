"""
Strava OAuth token management.

Loads the stored token, returns the current access token if still valid,
and only calls the Strava refresh endpoint when the token is within
5 minutes of expiry. Strava tokens are valid for 6 hours.
"""

import json
import os
import time
import requests

from health_data_hub.config.settings import (
    STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET,
    TOKEN_FILE,
)

TOKEN_URL = "https://www.strava.com/oauth/token"
_EXPIRY_BUFFER_SECONDS = 300  # refresh if less than 5 min remaining


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


def get_valid_access_token():
    """
    Return a valid Strava access token.

    Reuses the stored token if it has more than 5 minutes remaining.
    Only calls the Strava refresh endpoint when the token is expired
    or about to expire. Strava tokens are valid for ~6 hours, so under
    normal operation this refreshes roughly once every 6 hours instead
    of on every 5-minute poll cycle.
    """
    token_data = _load_token_file()

    expires_at = token_data.get("expires_at")
    access_token = token_data.get("access_token")

    if access_token and expires_at and time.time() < expires_at - _EXPIRY_BUFFER_SECONDS:
        print("[Token] Stored token still valid, skipping refresh.")
        return access_token

    print("[Token] Token expired or expiring soon, refreshing...")

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
    response.raise_for_status()

    try:
        tokens = response.json()
    except ValueError as e:
        raise RuntimeError(
            f"Refresh response was not valid JSON. "
            f"Status={response.status_code}, Body={response.text[:500]!r}"
        ) from e

    new_token = tokens.get("access_token")
    if not new_token:
        raise RuntimeError(f"No access_token returned from Strava: {tokens}")

    _save_token_file(tokens)
    print("[Token] Token refreshed and saved.")
    return new_token