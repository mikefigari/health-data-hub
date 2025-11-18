import requests
import json
from .strava_refresh import refresh_access_token

BASE_URL = "https://www.strava.com/api/v3"


def _auth_headers():
    """Return headers with a valid access token."""
    token = refresh_access_token()
    return {"Authorization": f"Bearer {token}"}


# -----------------------------------------------------------
# Fetch recent activities (metadata only)
# -----------------------------------------------------------
def get_recent_activities(limit=10):
    """
    Returns a list of recent Strava activities.
    """
    headers = _auth_headers()
    url = f"{BASE_URL}/athlete/activities?per_page={limit}"

    response = requests.get(url, headers=headers)
    response.raise_for_status()

    return response.json()


# -----------------------------------------------------------
# Fetch a single activity (detailed)
# -----------------------------------------------------------
def get_activity_details(activity_id):
    """
    Returns detailed information about a single activity.
    """
    headers = _auth_headers()
    url = f"{BASE_URL}/activities/{activity_id}"

    response = requests.get(url, headers=headers)
    response.raise_for_status()

    return response.json()


# -----------------------------------------------------------
# Fetch activity streams (second-by-second data)
# -----------------------------------------------------------
def get_activity_streams(activity_id, include_power=True):
    """
    Returns streams: time, latlng, distance, altitude,
                     power, heart_rate, cadence.
    """

    headers = _auth_headers()

    keys = ["time", "heartrate", "cadence", "watts", "distance", "velocity_smooth"]

    # Remove power if activity has no power (optional)
    if not include_power:
        keys.remove("watts")

    keys_str = ",".join(keys)

    url = f"{BASE_URL}/activities/{activity_id}/streams?keys={keys_str}&key_by_type=true"

    response = requests.get(url, headers=headers)
    response.raise_for_status()

    return response.json()
