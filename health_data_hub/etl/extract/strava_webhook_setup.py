"""
Manage Strava webhook subscriptions.

Strava allows at most one active push subscription per application.
Run this once to register the subscription; the webhook receiver then
handles all future activity events without polling.

Usage:
    HEALTH_ENV=prod python -m health_data_hub.etl.extract.strava_webhook_setup list
    HEALTH_ENV=prod python -m health_data_hub.etl.extract.strava_webhook_setup create
    HEALTH_ENV=prod python -m health_data_hub.etl.extract.strava_webhook_setup delete <subscription_id>

Requirements:
    STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET  — set in prod.env
    STRAVA_PUBLIC_WEBHOOK_URL               — public HTTPS URL Strava will call
                                              (e.g. https://your-worker.workers.dev/strava/webhook)
    STRAVA_WEBHOOK_VERIFY_TOKEN             — secret shared with the receiver

The 'create' command causes Strava to immediately issue a GET validation
request to STRAVA_PUBLIC_WEBHOOK_URL, so the webhook receiver (or Cloudflare
Worker) must be running and reachable before you run 'create'.
"""

import sys
import requests

from health_data_hub.config.settings import (
    STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET,
    STRAVA_PUBLIC_WEBHOOK_URL,
    STRAVA_WEBHOOK_VERIFY_TOKEN,
)

SUBSCRIPTIONS_URL = "https://www.strava.com/api/v3/push_subscriptions"
_AUTH_PARAMS = {
    "client_id": STRAVA_CLIENT_ID,
    "client_secret": STRAVA_CLIENT_SECRET,
}


def list_subscriptions() -> list:
    resp = requests.get(SUBSCRIPTIONS_URL, params=_AUTH_PARAMS, timeout=30)
    resp.raise_for_status()
    subs = resp.json()
    if not subs:
        print("No active subscriptions.")
    else:
        for sub in subs:
            print(
                f"  id={sub['id']}  "
                f"url={sub['callback_url']}  "
                f"created={sub['created_at']}"
            )
    return subs


def create_subscription() -> dict:
    if not STRAVA_PUBLIC_WEBHOOK_URL:
        print("ERROR: STRAVA_PUBLIC_WEBHOOK_URL is not set in the environment.")
        sys.exit(1)
    if not STRAVA_WEBHOOK_VERIFY_TOKEN:
        print("ERROR: STRAVA_WEBHOOK_VERIFY_TOKEN is not set in the environment.")
        sys.exit(1)

    print(f"Registering webhook subscription: {STRAVA_PUBLIC_WEBHOOK_URL}")
    print("(Strava will immediately validate this URL — the receiver must be reachable.)")

    resp = requests.post(
        SUBSCRIPTIONS_URL,
        data={
            **_AUTH_PARAMS,
            "callback_url": STRAVA_PUBLIC_WEBHOOK_URL,
            "verify_token": STRAVA_WEBHOOK_VERIFY_TOKEN,
        },
        timeout=30,
    )
    if resp.status_code == 201:
        sub = resp.json()
        print(f"Subscription created successfully. id={sub['id']}")
        print(f"Save this ID if you need to delete the subscription later.")
        return sub
    else:
        print(f"ERROR: {resp.status_code} — {resp.text}")
        sys.exit(1)


def delete_subscription(subscription_id: int) -> None:
    resp = requests.delete(
        f"{SUBSCRIPTIONS_URL}/{subscription_id}",
        params=_AUTH_PARAMS,
        timeout=30,
    )
    if resp.status_code == 204:
        print(f"Subscription {subscription_id} deleted.")
    else:
        print(f"ERROR: {resp.status_code} — {resp.text}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("create", "list", "delete"):
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "list":
        list_subscriptions()
    elif cmd == "create":
        create_subscription()
    elif cmd == "delete":
        if len(sys.argv) < 3:
            print("Usage: ... delete <subscription_id>")
            sys.exit(1)
        delete_subscription(int(sys.argv[2]))
