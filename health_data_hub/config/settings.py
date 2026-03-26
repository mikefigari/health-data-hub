"""
Centralized configuration for health_data_hub.

Loads environment variables once, determines project paths,
and exposes all configuration in a stable, importable module.
"""

import os
from pathlib import Path
from dotenv import load_dotenv
BASE_DIR = Path(__file__).resolve().parents[1]   # health_data_hub/health_data_hub
CONFIG_DIR = BASE_DIR / "config"

# Token file lives outside the project directory so it survives git operations
# and package reinstalls.  Override with STRAVA_TOKEN_FILE in your env file.
_DEFAULT_TOKEN_FILE = Path.home() / ".config" / "health-data-hub" / "strava_tokens.json"
TOKEN_FILE = Path(os.getenv("STRAVA_TOKEN_FILE", str(_DEFAULT_TOKEN_FILE)))


# -------------------------------------------------------------
# Project Paths
# -------------------------------------------------------------

# Directory: health_data_hub/config/settings.py
PROJECT_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = PROJECT_ROOT / "health_data_hub"

# -------------------------------------------------------------
# Environment Selection
# -------------------------------------------------------------

ENV_NAME = os.environ.get("HEALTH_ENV", "dev")

# Decide which env file to load
ENV_FILE = PACKAGE_ROOT / "config" / f"{ENV_NAME}.env"

if ENV_FILE.exists():
    load_dotenv(ENV_FILE)
# If the file doesn't exist, assume vars are already in the environment (e.g. sourced externally)


# -------------------------------------------------------------
# Database Configuration
# -------------------------------------------------------------

DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")


# -------------------------------------------------------------
# Strava API Configuration
# -------------------------------------------------------------

STRAVA_CLIENT_ID = os.getenv("STRAVA_CLIENT_ID")
STRAVA_CLIENT_SECRET = os.getenv("STRAVA_CLIENT_SECRET")
STRAVA_REDIRECT_URI = os.getenv("STRAVA_REDIRECT_URI")
STRAVA_SCOPE = os.getenv("STRAVA_SCOPE")


# -------------------------------------------------------------
# Notion API Configuration
# -------------------------------------------------------------

NOTION_TOKEN = os.getenv("NOTION_TOKEN")
NOTION_WORKOUT_DB_ID = os.getenv("NOTION_WORKOUT_DB_ID")
NOTION_DAILY_STATE_DB_ID = os.getenv("NOTION_DAILY_STATE_DB_ID")

OURA_PERSONAL_ACCESS_TOKEN = os.getenv("OURA_PERSONAL_ACCESS_TOKEN")


# -------------------------------------------------------------
# Apple Health Worker Configuration
# -------------------------------------------------------------

HEALTH_WORKER_URL = os.getenv("HEALTH_WORKER_URL")   # e.g. https://health.example.com/health
HEALTH_TOKEN      = os.getenv("HEALTH_TOKEN")


# -------------------------------------------------------------
# Anthropic API Configuration
# -------------------------------------------------------------

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")


