from apscheduler.schedulers.blocking import BlockingScheduler
from integrations.poll_strava import poll_once

scheduler = BlockingScheduler()

# Run every 5 minutes
scheduler.add_job(poll_once, "interval", minutes=5)

print("=== APScheduler started: polling Strava every 5 minutes ===")

scheduler.start()
