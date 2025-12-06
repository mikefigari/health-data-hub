from health_data_hub.integrations.oura.oura_api import fetch_sleep, fetch_activity
from datetime import date, timedelta

start = (date.today() - timedelta(days=2)).isoformat()
end = date.today().isoformat()

print("=== Sleep Payload ===")
print(fetch_sleep(start, end))

print("\n=== Activity Payload ===")
print(fetch_activity(start, end))
