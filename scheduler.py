"""
Strava poller scheduler. Polls for new activities every 5 minutes.
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from health_data_hub.utils.logging_config import setup_logging
from apscheduler.schedulers.blocking import BlockingScheduler
from health_data_hub.integrations.poll_strava import poll_once

setup_logging()

scheduler = BlockingScheduler()
scheduler.add_job(poll_once, "interval", minutes=5)

import logging
logger = logging.getLogger(__name__)
logger.info("APScheduler started: polling Strava every 5 minutes")

scheduler.start()
