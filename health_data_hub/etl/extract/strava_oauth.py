import http.server
import json
import logging
import os
import socketserver
import threading
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

# Load environment variables via settings (handles HEALTH_ENV-based dotenv loading)
from health_data_hub.config.settings import TOKEN_FILE

logger = logging.getLogger(__name__)


def _get_env(key: str) -> str:
    val = os.getenv(key)
    if not val:
        raise RuntimeError(
            f"Missing required env var: {key}. "
            "Run with HEALTH_ENV=prod or ensure the env file is loaded."
        )
    return val


class OAuthHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)

        if "code" not in query:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"No authorization code returned.")
            return

        code = query["code"][0]

        payload = {
            "client_id": _get_env("STRAVA_CLIENT_ID"),
            "client_secret": _get_env("STRAVA_CLIENT_SECRET"),
            "code": code,
            "grant_type": "authorization_code",
        }

        response = requests.post("https://www.strava.com/oauth/token", data=payload)
        tokens = response.json()

        if "access_token" not in tokens:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"Token exchange failed.")
            logger.error("[OAuth] Token exchange failed (HTTP %s)", response.status_code)
            return

        temp_file = Path(str(TOKEN_FILE) + ".tmp")
        with open(temp_file, "w") as f:
            json.dump(tokens, f, indent=4)
            f.flush()
            os.fsync(f.fileno())
        temp_file.replace(TOKEN_FILE)

        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"Authorization complete. You may close this window.")
        logger.info(f"[OAuth] Tokens saved to {TOKEN_FILE}")

        # Shut down the server from a separate thread (can't call from within a request handler)
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, format, *args):
        pass  # suppress access logs


def run_oauth():
    client_id = _get_env("STRAVA_CLIENT_ID")
    redirect_uri = _get_env("STRAVA_REDIRECT_URI")
    scope = os.getenv("STRAVA_SCOPE", "activity:read_all")

    auth_url = (
        "https://www.strava.com/oauth/authorize"
        f"?client_id={client_id}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code"
        f"&scope={scope}"
    )

    PORT = 8000
    logger.info("Opening Strava OAuth page...")
    webbrowser.open(auth_url)

    with socketserver.TCPServer(("", PORT), OAuthHandler) as httpd:
        logger.info(f"Listening for Strava redirect on http://localhost:{PORT} ...")
        httpd.serve_forever()

    logger.info("[OAuth] Done.")


if __name__ == "__main__":
    run_oauth()
