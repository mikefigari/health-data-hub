"""
Strava webhook receiver.

Runs a lightweight HTTP server in a background daemon thread.
Strava POSTs an event here whenever a new activity is created — no polling,
no timer-driven token refreshes.  The token is only fetched when a real
event arrives.

Endpoints:
    GET  /webhook  — Strava subscription validation (echoes hub.challenge)
    POST /webhook  — Activity event; triggers the full pipeline for that activity

Configuration (via env / prod.env):
    STRAVA_WEBHOOK_VERIFY_TOKEN  — shared secret registered with Strava
    STRAVA_WEBHOOK_PORT          — local port to listen on (default 8765)
"""

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

from health_data_hub.config.settings import (
    STRAVA_WEBHOOK_VERIFY_TOKEN,
    STRAVA_WEBHOOK_PORT,
)
from health_data_hub.etl.extract.strava_refresh import get_valid_access_token, StravaAuthError
from health_data_hub.etl.extract.strava_api import get_activity, get_activity_streams
from health_data_hub.etl.load.insert_workout import insert_workout_metadata as insert_workout
from health_data_hub.etl.load.insert_workout_samples import insert_workout_samples
from health_data_hub.etl.transform.build_workout_summary import build_summary_for
from health_data_hub.integrations.notion.notion_strava_sync import sync_specific_workout
from health_data_hub.integrations.poll_strava import _write_sync_log

logger = logging.getLogger(__name__)


# -------------------------------------------------------------------
# Pipeline
# -------------------------------------------------------------------

def _process_activity(strava_activity_id: int) -> None:
    """Fetch and run the full pipeline for a single Strava activity ID."""
    logger.info("Webhook: processing activity %s", strava_activity_id)

    try:
        access_token = get_valid_access_token()
    except StravaAuthError as e:
        logger.error("Webhook: auth failed for activity %s: %s", strava_activity_id, e)
        _write_sync_log("auth_error", error_message=str(e))
        return
    except Exception as e:
        logger.error("Webhook: token refresh error for activity %s: %s", strava_activity_id, e)
        _write_sync_log("error", error_message=f"Token refresh failed: {e}")
        return

    try:
        act = get_activity(access_token, strava_activity_id)
    except Exception as e:
        logger.error("Webhook: failed to fetch activity %s: %s", strava_activity_id, e)
        _write_sync_log("error", error_message=f"Activity fetch failed: {e}")
        return

    try:
        wid = insert_workout(act)
        logger.info("Webhook: inserted raw workout id=%s", wid)
    except Exception as e:
        logger.error("Webhook: workout insert failed for activity %s: %s", strava_activity_id, e)
        _write_sync_log("error", error_message=f"Workout insert failed: {e}")
        return

    try:
        streams = get_activity_streams(access_token, strava_activity_id)
    except Exception as e:
        logger.warning("Webhook: stream fetch failed for activity %s: %s", strava_activity_id, e)
        streams = None

    try:
        insert_workout_samples(wid, streams)
    except Exception as e:
        logger.error("Webhook: sample insert failed for workout %s: %s", wid, e)

    try:
        build_summary_for(wid)
        logger.info("Webhook: summary built for workout %s", wid)
    except Exception as e:
        logger.error("Webhook: summary build failed for workout %s: %s", wid, e)

    try:
        sync_specific_workout(wid)
        logger.info("Webhook: Notion sync complete for workout %s", wid)
    except Exception as e:
        logger.error("Webhook: Notion sync failed for workout %s: %s", wid, e)

    _write_sync_log("success", activities_found=1, activities_written=1)
    logger.info(
        "Webhook: pipeline complete for activity %s (workout_id=%s)",
        strava_activity_id, wid,
    )


# -------------------------------------------------------------------
# HTTP handler
# -------------------------------------------------------------------

class _StravaWebhookHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler for the two Strava webhook endpoints."""

    def do_GET(self):
        """Strava subscription validation: echo hub.challenge if verify_token matches."""
        if urlparse(self.path).path != "/webhook":
            self._respond(404, b"Not found")
            return

        params = parse_qs(urlparse(self.path).query)
        mode      = params.get("hub.mode",         [None])[0]
        challenge = params.get("hub.challenge",     [None])[0]
        token     = params.get("hub.verify_token",  [None])[0]

        if mode == "subscribe" and challenge and token == STRAVA_WEBHOOK_VERIFY_TOKEN:
            body = json.dumps({"hub.challenge": challenge}).encode()
            self._respond(200, body, content_type="application/json")
            logger.info("Webhook: validation challenge accepted")
        else:
            self._respond(403, b"Forbidden")
            logger.warning(
                "Webhook: validation rejected (mode=%r, token_match=%s)",
                mode, token == STRAVA_WEBHOOK_VERIFY_TOKEN,
            )

    def do_POST(self):
        """Receive an activity event from Strava (or the Cloudflare forwarder)."""
        if urlparse(self.path).path != "/webhook":
            self._respond(404, b"Not found")
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)

        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            self._respond(400, b"Bad request")
            return

        # Respond 200 immediately — Strava retries if it doesn't get a quick ACK
        self._respond(200, b"OK")

        if event.get("object_type") == "activity" and event.get("aspect_type") == "create":
            activity_id = event.get("object_id")
            if activity_id:
                threading.Thread(
                    target=_process_activity,
                    args=(activity_id,),
                    daemon=True,
                ).start()
            else:
                logger.warning("Webhook: create event missing object_id")
        else:
            logger.debug(
                "Webhook: ignoring event (object_type=%s, aspect_type=%s)",
                event.get("object_type"), event.get("aspect_type"),
            )

    def _respond(self, status: int, body: bytes, content_type: str = "text/plain") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # suppress default stderr logging
        logger.debug("Webhook HTTP: " + fmt, *args)


# -------------------------------------------------------------------
# Server lifecycle
# -------------------------------------------------------------------

def start_webhook_server() -> HTTPServer:
    """
    Start the Strava webhook receiver in a background daemon thread.

    The thread is a daemon so it exits automatically when the main scheduler
    process exits.  Returns the HTTPServer instance (rarely needed by callers).
    """
    server = HTTPServer(("0.0.0.0", STRAVA_WEBHOOK_PORT), _StravaWebhookHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info("Strava webhook receiver listening on port %d", STRAVA_WEBHOOK_PORT)
    return server
