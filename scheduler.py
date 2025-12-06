import sys
from pathlib import Path

# Ensure absolute imports work from any execution directory
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


from apscheduler.schedulers.blocking import BlockingScheduler
from health_data_hub.integrations.poll_strava import poll_once  # noqa: E402

scheduler = BlockingScheduler()

# Run every 5 minutes
scheduler.add_job(poll_once, "interval", minutes=5)

print("=== APScheduler started: polling Strava every 5 minutes ===")

scheduler.start()
