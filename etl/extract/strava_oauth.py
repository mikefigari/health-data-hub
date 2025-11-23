import http.server
import json
import os
import socketserver
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests
from dotenv import load_dotenv

# Load environment variables
load_dotenv(Path(__file__).resolve().parents[2] / "config" / "dev.env")

CLIENT_ID = os.getenv("STRAVA_CLIENT_ID")
CLIENT_SECRET = os.getenv("STRAVA_CLIENT_SECRET")
REDIRECT_URI = os.getenv("STRAVA_REDIRECT_URI")
SCOPE = os.getenv("STRAVA_SCOPE", "activity:read_all")

AUTH_URL = (
    "https://www.strava.com/oauth/authorize"
    f"?client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    f"&response_type=code"
    f"&scope={SCOPE}"
)


class OAuthHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Parse the callback query
        query = parse_qs(urlparse(self.path).query)

        if "code" not in query:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"No authorization code returned.")
            return

        code = query["code"][0]

        # Exchange code for token
        token_url = "https://www.strava.com/oauth/token"
        payload = {
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
        }

        response = requests.post(token_url, data=payload)
        tokens = response.json()

        # Save tokens locally
        token_path = Path(__file__).resolve().parents[2] / "config" / "strava_tokens.json"
        with open(token_path, "w") as f:
            json.dump(tokens, f, indent=4)

        # Return confirmation to the browser
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"Authorization complete. You may close this window.")


def run_oauth():
    PORT = 8000
    print("Opening Strava OAuth page...")
    webbrowser.open(AUTH_URL)

    with socketserver.TCPServer(("", PORT), OAuthHandler) as httpd:
        print(f"Listening for Strava redirect on http://localhost:{PORT} ...")
        httpd.serve_forever()


if __name__ == "__main__":
    run_oauth()
