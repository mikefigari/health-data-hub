"""
Strava fallback poller — catches activities missed by the webhook receiver.

Real-time processing is handled by strava_webhook.py, which reacts to Strava
push events within seconds.  This poller runs every 60 minutes as a backstop
in case a webhook event was lost (e.g. during a service restart or a transient
network gap between Strava and the Cloudflare Worker).

Workflow:
    1. Insert into workouts_raw
    2. Insert into workout_samples
    3. Build workout_summary (NP, IF, TSS)
    4. Sync that workout to Notion
"""

import logging
import time
from datetime import datetime, timezone

from health_data_hub.utils.db_connect import get_connection
from health_data_hub.etl.extract.strava_refresh import get_valid_access_token, StravaAuthError
from health_data_hub.utils.alert import send_alert
from health_data_hub.etl.extract.strava_api import (
    get_recent_activities,
    get_activity_streams,
)
from health_data_hub.etl.load.insert_workout import insert_workout_metadata as insert_workout
from health_data_hub.etl.load.insert_workout_samples import insert_workout_samples
from health_data_hub.etl.transform.build_workout_summary import build_summary_for
from health_data_hub.integrations.notion.notion_strava_sync import sync_specific_workout

logger = logging.getLogger(__name__)

POLL_INTERVAL = 3600  # 60 minutes (backstop; real-time handled by webhook receiver)

# Consecutive-failure counter — incremented each poll cycle that gets a StravaAuthError,
# reset to 0 on any successful token refresh.  An alert is sent once this reaches
# _ALERT_THRESHOLD, meaning Strava auth has been failing for roughly that many hours.
# A single transient 401 just waits for the next poll cycle — no backoff, no lockout.
_consecutive_auth_failures: int = 0
_ALERT_THRESHOLD = 4  # alert after ~4 consecutive hourly failures (~4 hours)

_POLL_HOUR_START = 6   # earliest hour to run the fallback poller (inclusive)
_POLL_HOUR_END   = 22  # hour at which polling stops (exclusive, i.e. last poll is 21:xx)


# -------------------------------------------------------------------
# Sync log
# -------------------------------------------------------------------

def _write_sync_log(status: str, activities_found: int = None,
                    activities_written: int = None, error_message: str = None):
    """Write one row to strava_sync_log.  Never raises — log errors are non-fatal."""
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO strava_sync_log
                (status, activities_found, activities_written, error_message)
            VALUES (%s, %s, %s, %s)
            """,
            (status, activities_found, activities_written, error_message),
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.error("Failed to write strava_sync_log: %s", e)


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

def parse_strava_ts(s: str):
    """Convert Strava ISO timestamp to aware datetime."""
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def get_last_synced_activity_time():
    """Return newest start_time from workouts_raw."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT MAX(start_time) FROM workouts_raw;")
    ts = cur.fetchone()[0]
    cur.close()
    conn.close()

    if ts is None:
        return None

    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


# -------------------------------------------------------------------
# Poll cycle
# -------------------------------------------------------------------

def poll_once():
    global _consecutive_auth_failures

    logger.info("=== Poll cycle start ===")

    last_sync = get_last_synced_activity_time()
    logger.info("Last DB sync timestamp: %s", last_sync)

    logger.info("Checking Strava OAuth token...")
    try:
        access_token = get_valid_access_token()
        if _consecutive_auth_failures > 0:
            logger.info(
                "Strava token refresh recovered after %d consecutive failure(s) — resuming normal polling.",
                _consecutive_auth_failures,
            )
            _consecutive_auth_failures = 0
    except StravaAuthError as e:
        _consecutive_auth_failures += 1
        _write_sync_log("auth_error", error_message=str(e))
        logger.warning(
            "Strava auth failed (401) — consecutive failures: %d. "
            "Will retry next poll cycle (~60 min). %s",
            _consecutive_auth_failures, e,
        )
        if _consecutive_auth_failures >= _ALERT_THRESHOLD:
            logger.critical(
                "Strava auth has been failing for %d+ consecutive poll cycles — sending alert.",
                _consecutive_auth_failures,
            )
            send_alert(
                subject="Strava auth failing — action may be required",
                body=(
                    f"Strava token refresh has failed {_consecutive_auth_failures} consecutive times "
                    f"(~{_consecutive_auth_failures} hours).\n\n"
                    f"Error: {e}\n\n"
                    "The poller is still retrying automatically every hour.\n\n"
                    "--- Step 1: Test the refresh token manually ---\n\n"
                    "  ssh mike@raspberrypi\n"
                    "  cd ~/projects/health-data-hub\n"
                    "  source .venv/bin/activate\n"
                    "  HEALTH_ENV=prod python3 -c \"\n"
                    "  import json, requests\n"
                    "  from health_data_hub.config.settings import STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, TOKEN_FILE\n"
                    "  tok = json.load(open(TOKEN_FILE))\n"
                    "  r = requests.post('https://www.strava.com/oauth/token', data={\n"
                    "    'client_id': STRAVA_CLIENT_ID, 'client_secret': STRAVA_CLIENT_SECRET,\n"
                    "    'grant_type': 'refresh_token', 'refresh_token': tok['refresh_token'],\n"
                    "  }, timeout=30)\n"
                    "  print(r.status_code, r.text[:200])\"\n\n"
                    "If that returns 200: Strava had a transient outage — the service will self-heal.\n"
                    "If that returns 401: the client_secret in prod.env may be wrong, or the refresh\n"
                    "  token was revoked (e.g. you re-authorized the app on another device).\n\n"
                    "--- Step 2: Only if Step 1 returns 401 ---\n\n"
                    "Re-authorize from the Pi:\n"
                    "  HEALTH_ENV=prod python -m health_data_hub.etl.extract.strava_reauth_headless\n"
                    "  sudo systemctl restart health-data-hub\n"
                ),
            )
        return
    except Exception as e:
        _write_sync_log("error", error_message=f"Token refresh failed: {e}")
        raise

    # Time-of-day gate: no workouts happen overnight, so skip the activity
    # fetch entirely.  The webhook handles real-time; this poller is just
    # a backstop for events missed during 6am–10pm.  Token refresh above runs
    # unconditionally so the token never expires unattended overnight.
    current_hour = datetime.now().hour
    if not (_POLL_HOUR_START <= current_hour < _POLL_HOUR_END):
        logger.debug(
            "Strava fallback poller: outside active hours (%02d:00–%02d:00), skipping activity fetch.",
            _POLL_HOUR_START, _POLL_HOUR_END,
        )
        return

    logger.info("Fetching recent activities...")
    try:
        activities = get_recent_activities(access_token, limit=30)
    except Exception as e:
        _write_sync_log("error", error_message=f"API fetch failed: {e}")
        raise

    for act in activities:
        act["_dt"] = parse_strava_ts(act.get("start_date_local"))

    activities.sort(
        key=lambda a: a["_dt"] or datetime.min.replace(tzinfo=timezone.utc)
    )

    found_new = False
    written = 0

    for act in activities:
        act_dt = act["_dt"]
        if act_dt is None:
            continue

        if last_sync is None or act_dt > last_sync:
            logger.info("New workout: %s @ %s", act["name"], act_dt)

            # 1) Insert workouts_raw
            wid = insert_workout(act)
            logger.info("Inserted raw workout id=%s", wid)

            # 2) Insert workout_samples
            try:
                streams = get_activity_streams(access_token, act["id"])
            except Exception as e:
                logger.warning("Stream fetch failed for activity %s: %s", act["id"], e)
                streams = None

            try:
                insert_workout_samples(wid, streams)
            except Exception as e:
                logger.error("Sample insert failed for workout %s: %s", wid, e)

            # 3) Build summary row
            try:
                build_summary_for(wid)
                logger.info("Summary built for workout %s", wid)
            except Exception as e:
                logger.error("Summary build failed for workout %s: %s", wid, e)

            # 4) Sync to Notion
            try:
                sync_specific_workout(wid)
                logger.info("Notion sync complete for workout %s", wid)
            except Exception as e:
                logger.error("Notion sync failed for workout %s: %s", wid, e)

            found_new = True
            written += 1

    if not found_new:
        logger.info("No new workouts found.")
        _write_sync_log("no_data", activities_found=len(activities), activities_written=0)
    else:
        _write_sync_log("success", activities_found=len(activities), activities_written=written)

    logger.info("=== Poll cycle complete ===")


def poll_loop():
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()

    logger.info("=== Strava Poller Started ===")
    logger.info("Polling every %s seconds", POLL_INTERVAL)

    while True:
        try:
            poll_once()
        except Exception as e:
            logger.error("Poll cycle failed: %s", e, exc_info=True)

        logger.info("Sleeping %s seconds...", POLL_INTERVAL)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    poll_loop()
