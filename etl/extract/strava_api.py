import requests
from .strava_refresh import refresh_access_token

BASE_URL = "https://www.strava.com/api/v3"


def _auth_headers():
    """Return headers with a valid access token."""
    token = refresh_access_token()
    return {"Authorization": f"Bearer {token}"}


# -----------------------------------------------------------
# Fetch recent activities (metadata only)
# -----------------------------------------------------------
def get_recent_activities(per_page=10, page=1, limit=None):
    """
    Returns a list of recent Strava activities (paged).
    Accepts legacy `limit` for compatibility.
    """
    if limit is not None and per_page == 10:
        per_page = limit

    headers = _auth_headers()
    params = {"per_page": per_page, "page": page}
    url = f"{BASE_URL}/athlete/activities"

    response = requests.get(url, headers=headers, params=params)

    if response.status_code == 429:
        raise Exception("Strava rate limit exceeded (429). Please retry later.")

    response.raise_for_status()
    return response.json()


def get_all_strava_activities():
    """
    Fetch the full history of Strava activities, paging in batches of 100.
    """
    all_activities = []
    page = 1

    while True:
        batch = get_recent_activities(per_page=100, page=page)
        if not batch:
            break

        all_activities.extend(batch)

        # Last page
        if len(batch) < 100:
            break

        page += 1

    return all_activities


# -----------------------------------------------------------
# Fetch a single activity (detailed)
# -----------------------------------------------------------
def get_activity_details(activity_id):
    """Return detailed information about a single activity."""
    headers = _auth_headers()
    url = f"{BASE_URL}/activities/{activity_id}"

    response = requests.get(url, headers=headers)

    if response.status_code == 429:
        raise Exception("Strava rate limit exceeded (429) while fetching activity.")

    response.raise_for_status()
    return response.json()


# -----------------------------------------------------------
# Fetch activity streams (second-by-second data)
# -----------------------------------------------------------
def get_activity_streams(activity_id):
    """
    Returns streams keyed by type: heartrate, cadence, time, watts, velocity_smooth.
    If the Strava activity has no streams (404), returns None.
    If rate-limited, raises a controlled 429 error for the caller to retry.
    """
    headers = _auth_headers()
    params = {
        "keys": "heartrate,cadence,time,watts,velocity_smooth",
        "key_by_type": "true",
    }
    url = f"{BASE_URL}/activities/{activity_id}/streams"

    response = requests.get(url, headers=headers, params=params)

    # Normal case for many Strava activities
    if response.status_code == 404:
        print(f"[STRAVA] No streams available for activity {activity_id} (404).")
        return None

    if response.status_code == 429:
        raise Exception("429 Rate Limit while fetching activity streams.")

    response.raise_for_status()
    return response.json()
