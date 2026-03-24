# Health Auto Export — Setup Guide

This guide configures the **Health Auto Export** iOS app (by Gregory Chicote) to push
Apple Health nutrition and workout data to the health-data-hub webhook receiver running
on the Raspberry Pi.

---

## Prerequisites

- Health Auto Export installed from the App Store
- The Pi and your iPhone on the same local network (or the Pi reachable by hostname/IP)
- The webhook receiver running on the Pi:

```bash
# In a separate terminal or as a systemd service:
cd ~/projects/health-data-hub
.venv/bin/python -m health_data_hub.integrations.apple_health.health_webhook_receiver
```

---

## Step 1 — Enable data types

Open Health Auto Export → **Export** tab → **Add Data Type**.

Enable the following Apple Health categories:

| Data Type | Apple Health Identifier | Notes |
|-----------|------------------------|-------|
| Dietary Energy Consumed | `HKQuantityTypeIdentifierDietaryEnergyConsumed` | kcal preferred; app will convert kJ automatically |
| Dietary Protein | `HKQuantityTypeIdentifierDietaryProtein` | grams |
| Dietary Carbohydrates | `HKQuantityTypeIdentifierDietaryCarbohydrates` | grams |
| Dietary Fat (Total) | `HKQuantityTypeIdentifierDietaryFatTotal` | grams |
| Dietary Fiber | `HKQuantityTypeIdentifierDietaryFiber` | grams |
| Workouts | `HKWorkoutTypeIdentifier` | for cycling energy cross-reference |

You do not need to enable sleep or heart rate — those come from Oura.

---

## Step 2 — Configure the webhook endpoint

1. In Health Auto Export, go to **Automations** (or **Export** → **Webhook**)
2. Tap **Add Automation** → **Webhook**
3. Set:
   - **URL**: `http://<pi-hostname-or-ip>:8765/health`
   - **Method**: POST
   - **Format**: JSON
4. Under **Data Range**, select **Last 7 days** (ensures missed nights are backfilled)
5. Leave authentication blank (the receiver is local-network only)

Replace `<pi-hostname-or-ip>` with the Pi's local IP (e.g. `192.168.1.42`) or hostname
(e.g. `raspberrypi.local`).

---

## Step 3 — Set the automation schedule

Set the trigger to run **nightly at 9:30 PM**. This ensures the day's food logging in
the Health app has synced before the morning briefing runs.

In Health Auto Export:
- **Automation type**: Time-based
- **Time**: 9:30 PM
- **Repeat**: Daily

---

## Step 4 — Test the connection

### Option A — Test from within the app

1. After configuring the webhook, tap **Test** or **Send Now** in the automation settings
2. Check the Pi logs for a confirmation line:

```
[INFO] Wrote nutrition data for 2026-03-24 → .../data/nutrition/2026-03-24.json
```

### Option B — Manual curl test from the Pi

```bash
curl -X POST http://localhost:8765/health \
     -H "Content-Type: application/json" \
     -d '{
       "data": {
         "metrics": [
           {
             "name": "dietary_energy_consumed",
             "units": "kcal",
             "data": [{"date": "2026-03-24 00:00:00 -0700", "qty": 2150}]
           },
           {
             "name": "dietary_protein",
             "units": "g",
             "data": [{"date": "2026-03-24 00:00:00 -0700", "qty": 165}]
           }
         ]
       }
     }'
```

Expected response:
```json
{"status": "ok", "dates_written": ["2026-03-24"]}
```

### Option C — Verify the written file

```bash
cat ~/projects/health-data-hub/data/nutrition/2026-03-24.json
```

---

## Step 5 — Run the webhook receiver as a systemd service (optional)

Create `/etc/systemd/system/health-webhook.service`:

```ini
[Unit]
Description=Health Auto Export Webhook Receiver
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mike
WorkingDirectory=/home/mike/projects/health-data-hub
EnvironmentFile=/home/mike/.config/health-data-hub/prod.env
ExecStart=/home/mike/projects/health-data-hub/.venv/bin/python \
    -m health_data_hub.integrations.apple_health.health_webhook_receiver
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=health-webhook

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable health-webhook
sudo systemctl start health-webhook
sudo journalctl -u health-webhook -f
```

---

## Data flow summary

```
iPhone (Health Auto Export)
  → nightly POST at 9:30 PM
  → http://<pi>:8765/health
  → health_webhook_receiver.py
  → data/nutrition/YYYY-MM-DD.json
  → nutrition_reader.get_nutrition(date)
  → morning_briefing.py (6 AM or manual)
  → Claude analysis
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Connection refused` on iPhone | Webhook receiver not running | Start the service or run manually |
| `404` response | Wrong URL path | Ensure URL ends in `/health` |
| `dates_written: []` | Metric names not recognised | Check app version; names may differ — see `_METRIC_MAP` in `health_webhook_receiver.py` |
| Morning briefing shows "not yet received" | Webhook ran after 9:30 but data not synced | Tap "Send Now" in the app or re-run the automation |
| Energy in kJ instead of kcal | App configured to use kJ | The receiver converts automatically; or switch app units to kcal |
