from datetime import date, timedelta
from pathlib import Path
import json

from health_data_hub.integrations.oura.oura_api import fetch_sleep, fetch_activity

out_dir = Path(__file__).resolve().parent / "sample_payloads"
out_dir.mkdir(exist_ok=True)

start = (date.today() - timedelta(days=2)).isoformat()
end = date.today().isoformat()

sleep = fetch_sleep(start, end)
activity = fetch_activity(start, end)

# Write raw payloads
(out_dir / "sleep_sample.json").write_text(json.dumps(sleep, indent=2))
(out_dir / "activity_sample.json").write_text(json.dumps(activity, indent=2))

# ---- Structural summary (Pass 1) ----

def summarize(name, payload):
    data = payload.get("data")
    print(f"\n{name}")
    print("Top-level keys:", list(payload.keys()))
    print("data type:", type(data).__name__)
    print("record count:", len(data) if isinstance(data, list) else "N/A")

summarize("Sleep payload:", sleep)
summarize("Activity payload:", activity)

print("\nOura sample payloads written to:", out_dir)
