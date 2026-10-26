"""
Unified scheduler for all health_data_hub pollers.

Intended for deployment on the Raspberry Pi as a single process
managed by systemd. Replaces the separate scheduler.py (Strava) and
run_oura_scheduler.bat (Oura) used on the Windows main PC.

Jobs:
    - Strava webhook:      HTTP receiver on STRAVA_WEBHOOK_PORT (default 8765), started at
                           launch in a background thread; handles real-time activity events
    - Strava poll:         every 60 minutes (configurable via STRAVA_POLL_INTERVAL_MIN),
                           backstop only — catches any events missed by the webhook
    - Oura:                every 30 minutes, 5 AM – 3 PM
    - Notion Daily State:  every 30 minutes, 5 AM – 11 PM (configurable)
    - Body measurements:   hourly at :20, 6 AM – 11 PM PT (Renpho weigh-ins via Health Auto Export)

Environment variables (set in dev.env / prod.env):
    STRAVA_POLL_INTERVAL_MIN                Minutes between Strava fallback polls (default: 60)
    STRAVA_WEBHOOK_PORT                     Port for local webhook receiver (default: 8765)
    NOTION_DAILY_STATE_POLL_INTERVAL_MIN    Minutes between Notion Daily State polls (default: 30)
    NOTION_DAILY_STATE_POLL_START_HOUR      Start hour for Notion Daily State polling, 0-23 (default: 5)
    NOTION_DAILY_STATE_POLL_END_HOUR        End hour for Notion Daily State polling, 0-23 (default: 23)
"""

import logging
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from health_data_hub.utils.logging_config import setup_logging

setup_logging()
logger = logging.getLogger(__name__)

from apscheduler.schedulers.blocking import BlockingScheduler
from health_data_hub.integrations.poll_strava import poll_once
from health_data_hub.integrations.strava_webhook import start_webhook_server
from health_data_hub.integrations.oura.poll_oura import poll_oura
from health_data_hub.integrations.notion.poll_notion_daily_state import poll_notion_daily_state
from health_data_hub.integrations.apple_health.body_poller import poll_once as poll_body
from health_data_hub.integrations.notion.notion_strava_sync import sync_weekly_zone_summary
from health_data_hub.integrations.datawrapper.ftp_wkg_charts import sync_once as sync_ftp_wkg_charts

# -------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------

STRAVA_INTERVAL_MIN = int(os.getenv("STRAVA_POLL_INTERVAL_MIN", "60"))
NOTION_DAILY_STATE_POLL_INTERVAL_MIN = int(os.getenv("NOTION_DAILY_STATE_POLL_INTERVAL_MIN", "30"))
NOTION_DAILY_STATE_POLL_START_HOUR = int(os.getenv("NOTION_DAILY_STATE_POLL_START_HOUR", "5"))
NOTION_DAILY_STATE_POLL_END_HOUR = int(os.getenv("NOTION_DAILY_STATE_POLL_END_HOUR", "23"))

if NOTION_DAILY_STATE_POLL_INTERVAL_MIN <= 0:
    raise ValueError("NOTION_DAILY_STATE_POLL_INTERVAL_MIN must be > 0")
if not 0 <= NOTION_DAILY_STATE_POLL_START_HOUR <= 23:
    raise ValueError("NOTION_DAILY_STATE_POLL_START_HOUR must be between 0 and 23")
if not 0 <= NOTION_DAILY_STATE_POLL_END_HOUR <= 23:
    raise ValueError("NOTION_DAILY_STATE_POLL_END_HOUR must be between 0 and 23")
if NOTION_DAILY_STATE_POLL_START_HOUR > NOTION_DAILY_STATE_POLL_END_HOUR:
    raise ValueError("NOTION_DAILY_STATE_POLL_START_HOUR cannot be greater than NOTION_DAILY_STATE_POLL_END_HOUR")

NOTION_POLL_HOUR_EXPR = f"{NOTION_DAILY_STATE_POLL_START_HOUR}-{NOTION_DAILY_STATE_POLL_END_HOUR}"
NOTION_POLL_MINUTE_EXPR = f"*/{NOTION_DAILY_STATE_POLL_INTERVAL_MIN}"


# -------------------------------------------------------------------
# Job wrappers (catch all exceptions so one failure doesn't kill the scheduler)
# -------------------------------------------------------------------

def run_strava():
    try:
        poll_once()
    except Exception:
        logger.error("Strava poll cycle failed", exc_info=True)


def run_oura():
    try:
        exit_code = poll_oura(days_back_sleep=3, days_back_activity=1)
        if exit_code != 0:
            logger.warning("Oura poll completed with errors (exit_code=%d)", exit_code)
    except Exception:
        logger.error("Oura poll cycle failed", exc_info=True)


def run_notion_daily_state():
    try:
        exit_code = poll_notion_daily_state(days_back=30)
        if exit_code != 0:
            logger.warning("Notion daily state poll completed with errors (exit_code=%d)", exit_code)
    except Exception:
        logger.error("Notion daily state poll cycle failed", exc_info=True)


def run_body_poller():
    try:
        exit_code = poll_body()
        if exit_code != 0:
            logger.warning("Body measurements poll completed with errors (exit_code=%d)", exit_code)
    except Exception:
        logger.error("Body measurements poll cycle failed", exc_info=True)


def run_ftp_wkg_charts():
    try:
        exit_code = sync_ftp_wkg_charts()
        if exit_code != 0:
            logger.warning("FTP/W-kg chart sync completed with errors (exit_code=%d)", exit_code)
    except Exception:
        logger.error("FTP/W-kg chart sync failed", exc_info=True)


def run_weekly_powerzone_summary():
    try:
        sync_weekly_zone_summary()
    except Exception:
        logger.error("Weekly power-zone summary failed", exc_info=True)


# -------------------------------------------------------------------
# Scheduler setup
# -------------------------------------------------------------------

scheduler = BlockingScheduler()

scheduler.add_job(
    run_strava,
    trigger="interval",
    minutes=STRAVA_INTERVAL_MIN,
    id="strava_poller",
    name="Strava fallback poller",
    max_instances=1,  # prevent overlap if a poll runs long
)

scheduler.add_job(
    run_oura,
    trigger="cron",
    hour="5-15",
    minute="0,30",
    id="oura_poller",
    name="Oura poller",
    max_instances=1,
)

scheduler.add_job(
    run_notion_daily_state,
    trigger="cron",
    hour=NOTION_POLL_HOUR_EXPR,
    minute=NOTION_POLL_MINUTE_EXPR,
    id="notion_daily_state_poller",
    name="Notion daily state poller",
    max_instances=1,
)

scheduler.add_job(
    run_body_poller,
    trigger="cron",
    hour="6-23",
    minute=20,
    id="body_poller",
    name="Body measurements poller",
    max_instances=1,
)

scheduler.add_job(
    run_ftp_wkg_charts,
    trigger="cron",
    hour="6-23",
    minute=40,
    id="ftp_wkg_charts",
    name="FTP / W-kg Datawrapper charts",
    max_instances=1,
)

scheduler.add_job(
    run_weekly_powerzone_summary,
    trigger="cron",
    day_of_week="sun",
    hour=21,
    minute=0,
    id="weekly_powerzone_summary",
    name="Weekly power-zone zone summary",
    max_instances=1,
)

start_webhook_server()

logger.info(
    "Unified scheduler starting — Strava webhook on port %s, "
    "Strava fallback poll every %d min, Oura every 30 min (5am-3pm), "
    "Notion daily state every %d min (%02d:00-%02d:59), "
    "Body measurements poller hourly at :20 (6am-11pm), "
    "FTP/W-kg charts hourly at :40 (6am-11pm), "
    "Weekly power-zone summary Sundays 21:00",
    os.getenv("STRAVA_WEBHOOK_PORT", "8765"),
    STRAVA_INTERVAL_MIN,
    NOTION_DAILY_STATE_POLL_INTERVAL_MIN,
    NOTION_DAILY_STATE_POLL_START_HOUR,
    NOTION_DAILY_STATE_POLL_END_HOUR,
)

try:
    scheduler.start()
except (KeyboardInterrupt, SystemExit):
    logger.info("Scheduler stopped.")
