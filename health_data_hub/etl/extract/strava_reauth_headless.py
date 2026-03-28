"""
Headless Strava OAuth re-authorization helper.

Use this when the refresh token has been revoked (the automatic refresh fails
with 401) and you need to obtain a fresh token pair without a browser on the
Pi itself.

Usage:
    HEALTH_ENV=prod python -m health_data_hub.etl.extract.strava_reauth_headless

Steps:
    1. The script prints a Strava authorization URL.
    2. Open that URL in any browser (phone, laptop, etc.).
    3. Authorize the app — Strava redirects to your redirect URI, which will
       fail to load (that's fine; you only need the URL from the address bar).
    4. Paste the full redirect URL (or just the 'code' query parameter) back
       into this terminal prompt.
    5. The script exchanges the code for tokens and saves them to disk.
    6. Restart the service: sudo systemctl restart health-data-hub
"""

import json
import os
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

# Load settings (handles HEALTH_ENV-based dotenv)
from health_data_hub.config.settings import (
    STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET,
    STRAVA_REDIRECT_URI,
    STRAVA_SCOPE,
    TOKEN_FILE,
)

TOKEN_URL = "https://www.strava.com/oauth/token"


def _build_auth_url() -> str:
    scope = STRAVA_SCOPE or "activity:read_all"
    return (
        "https://www.strava.com/oauth/authorize"
        f"?client_id={STRAVA_CLIENT_ID}"
        f"&redirect_uri={STRAVA_REDIRECT_URI}"
        f"&response_type=code"
        f"&approval_prompt=force"
        f"&scope={scope}"
    )


def _extract_code(raw: str) -> str:
    """Accept either a full redirect URL or a bare code string."""
    raw = raw.strip()
    if raw.startswith("http"):
        qs = parse_qs(urlparse(raw).query)
        codes = qs.get("code")
        if not codes:
            raise ValueError(
                "No 'code' parameter found in the URL you pasted.\n"
                "Make sure you copy the full URL from the browser address bar\n"
                "after Strava redirects you."
            )
        return codes[0]
    # Assume the user pasted the code directly
    return raw


def _exchange_code(code: str) -> dict:
    payload = {
        "client_id": STRAVA_CLIENT_ID,
        "client_secret": STRAVA_CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
    }
    response = requests.post(TOKEN_URL, data=payload, timeout=30)
    if response.status_code == 400:
        raise RuntimeError(
            f"Code exchange failed (400) — the code may have already been used "
            f"or has expired (codes are single-use and expire in ~10 minutes).\n"
            f"Response: {response.text[:300]}"
        )
    response.raise_for_status()
    tokens = response.json()
    if "access_token" not in tokens:
        raise RuntimeError(f"Unexpected response from Strava: {tokens}")
    return tokens


def _save_tokens(tokens: dict):
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = TOKEN_FILE.with_suffix(".json.tmp")
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(tokens, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(TOKEN_FILE)


def run():
    print("=" * 60)
    print("  Strava Headless Re-Authorization")
    print("=" * 60)
    print()

    for var, val in [
        ("STRAVA_CLIENT_ID", STRAVA_CLIENT_ID),
        ("STRAVA_CLIENT_SECRET", STRAVA_CLIENT_SECRET),
        ("STRAVA_REDIRECT_URI", STRAVA_REDIRECT_URI),
    ]:
        if not val:
            print(f"ERROR: {var} is not set. Check your prod.env file.", file=sys.stderr)
            sys.exit(1)

    auth_url = _build_auth_url()

    print("Step 1 — Open this URL in any browser (phone or laptop):")
    print()
    print(f"  {auth_url}")
    print()
    print("Step 2 — Click 'Authorize' on the Strava page.")
    print("         Your browser will redirect to a URL that fails to load.")
    print("         That's fine. Copy the full URL from the address bar.")
    print()

    raw = input("Step 3 — Paste the redirect URL (or just the 'code' value) here:\n> ").strip()
    if not raw:
        print("Nothing entered. Aborting.", file=sys.stderr)
        sys.exit(1)

    try:
        code = _extract_code(raw)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    print()
    print("Exchanging authorization code for tokens...")
    try:
        tokens = _exchange_code(code)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    _save_tokens(tokens)

    athlete = tokens.get("athlete", {})
    name = f"{athlete.get('firstname', '')} {athlete.get('lastname', '')}".strip()
    import time
    expires_in_min = int((tokens["expires_at"] - time.time()) / 60)

    print()
    print(f"Tokens saved to: {TOKEN_FILE}")
    print(f"Athlete:         {name or '(unknown)'}")
    print(f"Access token expires in: ~{expires_in_min} minutes")
    print()
    print("Re-authorization complete.")
    print()
    print("Restart the service to resume polling:")
    print("  sudo systemctl restart health-data-hub")


if __name__ == "__main__":
    run()
