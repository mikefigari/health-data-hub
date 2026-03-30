"""
Strava OAuth token management.

Loads the stored token, returns the current access token if still valid,
and only calls the Strava refresh endpoint when the token is within
5 minutes of expiry. Strava tokens are valid for 6 hours.
"""

import fcntl
import json
import os
import threading
import time
import requests

from health_data_hub.config.settings import (
    STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET,
    TOKEN_FILE,
)

TOKEN_URL = "https://www.strava.com/oauth/token"
_EXPIRY_BUFFER_SECONDS = 3600  # refresh if less than 60 min remaining
_LOCK_FILE = TOKEN_FILE.with_suffix(".lock")
_threading_lock = threading.Lock()  # intra-process serialization (fcntl only covers inter-process)

_REAUTH_CMD = "HEALTH_ENV=prod python -m health_data_hub.etl.extract.strava_oauth"


class StravaAuthError(RuntimeError):
    """Raised when Strava rejects the refresh token (401).
    Re-authorization via the OAuth flow is required — automatic retries will not help.
    """


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

    Reuses the stored token if it has more than 60 minutes remaining.
    Only calls the Strava refresh endpoint when the token is within an
    hour of expiry. Refreshing proactively means a mid-poll expiry is
    virtually impossible even if a poll cycle runs long.

    Two locks are used in combination:
    - threading.Lock (_threading_lock): serializes callers within the same
      process (e.g. the APScheduler poller thread and a webhook handler
      thread both attempting refresh at the same instant).
    - fcntl.LOCK_EX: serializes callers across separate processes (e.g. a
      manual backfill running alongside the scheduler).
    Both are needed: fcntl alone does not protect threads within a process.
    """
    with _threading_lock:
        with open(_LOCK_FILE, "w") as _lock:
            fcntl.flock(_lock, fcntl.LOCK_EX)
            return _get_valid_access_token_locked()


def _get_valid_access_token_locked():
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

    _MAX_REFRESH_RETRIES = 5
    _REFRESH_RETRY_DELAYS = [10, 20, 40, 80]  # seconds; exponential backoff, ~2.5 min total

    response = None
    for attempt in range(1, _MAX_REFRESH_RETRIES + 1):
        response = requests.post(TOKEN_URL, data=payload, timeout=30)
        if response.status_code != 401:
            break
        if attempt < _MAX_REFRESH_RETRIES:
            delay = _REFRESH_RETRY_DELAYS[attempt - 1]
            print(
                f"[Token] 401 on refresh attempt {attempt}/{_MAX_REFRESH_RETRIES}, "
                f"retrying in {delay}s..."
            )
            time.sleep(delay)

    if response.status_code == 401:
        raise StravaAuthError(
            f"Strava refresh token rejected (401) after {_MAX_REFRESH_RETRIES} attempts — "
            f"OAuth re-authorization required. Run: {_REAUTH_CMD}"
        )
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