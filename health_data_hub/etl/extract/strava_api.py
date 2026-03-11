"""
Strava API interface for metadata and stream retrieval.
"""

import requests

BASE_URL = "https://www.strava.com/api/v3"


def _auth_headers(access_token: str):
    """Return headers for Strava requests."""
    return {"Authorization": f"Bearer {access_token}"}


def _safe_json(response: requests.Response, context: str):
    """Parse JSON safely with good error messages."""
    try:
        return response.json()
    except ValueError as e:
        raise RuntimeError(
            f"{context} returned invalid JSON. "
            f"Status={response.status_code}, "
            f"Content-Type={response.headers.get('Content-Type')}, "
            f"Body={response.text[:500]!r}"
        ) from e


def get_recent_activities(access_token: str, limit: int = 10):
    """Fetch recent activities metadata."""
    response = requests.get(
        f"{BASE_URL}/athlete/activities?per_page={limit}",
        headers=_auth_headers(access_token),
        timeout=30,
    )

    print(f"[DEBUG activities] status={response.status_code}")
    print(f"[DEBUG activities] body={response.text[:500]!r}")

    response.raise_for_status()
    return _safe_json(response, "Recent activities request")


def get_activity_streams(access_token: str, activity_id: int):
    """Fetch activity stream data."""
    response = requests.get(
        f"{BASE_URL}/activities/{activity_id}/streams?keys=watts,heartrate,cadence,time,latlng&key_by_type=true",
        headers=_auth_headers(access_token),
        timeout=30,
    )

    print(f"[DEBUG streams] status={response.status_code}")
    print(f"[DEBUG streams] body={response.text[:500]!r}")

    response.raise_for_status()
    return _safe_json(response, f"Streams request for activity {activity_id}")