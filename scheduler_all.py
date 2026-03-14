"""
Unified scheduler for all health_data_hub pollers.

Intended for deployment on the Raspberry Pi as a single process
managed by systemd. Replaces the separate scheduler.py (Strava) and
run_oura_scheduler.bat (Oura) used on the Windows main PC.

Jobs:
    - Strava:  every 5 minutes (configurable via STRAVA_POLL_INTERVAL_MIN)
    - Oura:    daily at a configurable hour (OURA_POLL_HOUR, default 7 AM)

Environment variables (set in dev.env / prod.env):
    STRAVA_POLL_INTERVAL_MIN   Minutes between Strava polls (default: 5)
    OURA_POLL_HOUR             Hour of day for Oura poll, 0-23 (default: 7)
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
from health_data_hub.integrations.oura.poll_oura import poll_oura

# -------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------

STRAVA_INTERVAL_MIN = int(os.getenv("STRAVA_POLL_INTERVAL_MIN", "5"))
OURA_POLL_HOUR = int(os.getenv("OURA_POLL_HOUR", "7"))


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


# -------------------------------------------------------------------
# Scheduler setup
# -------------------------------------------------------------------

scheduler = BlockingScheduler()

scheduler.add_job(
    run_strava,
    trigger="interval",
    minutes=STRAVA_INTERVAL_MIN,
    id="strava_poller",
    name="Strava poller",
    max_instances=1,  # prevent overlap if a poll runs long
)

scheduler.add_job(
    run_oura,
    trigger="cron",
    hour=OURA_POLL_HOUR,
    minute=0,
    id="oura_poller",
    name="Oura daily poller",
    max_instances=1,
)

logger.info(
    "Unified scheduler starting — Strava every %d min, Oura daily at %02d:00",
    STRAVA_INTERVAL_MIN,
    OURA_POLL_HOUR,
)

try:
    scheduler.start()
except (KeyboardInterrupt, SystemExit):
    logger.info("Scheduler stopped.")
