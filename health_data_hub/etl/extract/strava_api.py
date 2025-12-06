"""
Strava API interface for metadata and stream retrieval.
"""

import requests

from health_data_hub.config.settings import (
    STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET,
)

from .strava_refresh import refresh_access_token


BASE_URL = "https://www.strava.com/api/v3"


def _auth_headers():
    """
    Return headers with a current valid access token.
    """
    token = refresh_access_token()
    return {"Authorization": f"Bearer {token}"}


def get_recent_activities(limit=10):
    """
    Fetch recent activities metadata only.
    """
    response = requests.get(
        f"{BASE_URL}/athlete/activities?per_page={limit}",
        headers=_auth_headers(),
    )
    response.raise_for_status()
    return response.json()


def get_activity_streams(activity_id: int):
    """
    Fetch detailed stream data (watts, hr, cadence, etc).
    """
    response = requests.get(
        f"{BASE_URL}/activities/{activity_id}/streams?keys=watts,heartrate,cadence,time,latlng&key_by_type=true",
        headers=_auth_headers(),
    )
    response.raise_for_status()
    return response.json()
