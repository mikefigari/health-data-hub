# Health Auto Export — Setup Guide

This guide configures the **Health Auto Export** iOS app (by Gregory Chicote) to push
Apple Health nutrition data to the Cloudflare Worker, which the Pi poller then pulls
from on an hourly schedule.

---

## Prerequisites

- Health Auto Export installed from the App Store
- The `nutrition_poller` job running inside `health-data-hub.service` on the Pi

---

## Step 1 — Enable data types

Open Health Auto Export → **Export** tab → **Add Data Type**.

Enable the following Apple Health categories:

| Data Type | Apple Health Identifier | Notes |
|-----------|------------------------|-------|
| Dietary Energy Consumed | `HKQuantityTypeIdentifierDietaryEnergyConsumed` | kcal preferred; Worker converts kJ automatically |
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
   - **URL**: `https://health.michaelfigari.com/health`
   - **Method**: POST
   - **Format**: JSON
4. Under **Custom Headers**, add:
   - **Header name**: `X-Health-Token`
   - **Header value**: *(the token from `HEALTH_TOKEN` in prod.env)*
5. Under **Data Range**, select **Last 7 days** (ensures missed days are backfilled)

> **Note:** The old setup used `http://<pi-hostname>:8765/health` on the local network.
> The new endpoint is the public Cloudflare Worker URL and requires the auth token header.

---

## Step 3 — Set the automation schedule

Set the trigger to run **nightly at 9:30 PM**. This ensures the day's food logging in
the Health app has synced before the Pi poller picks it up.

In Health Auto Export:
- **Automation type**: Time-based
- **Time**: 9:30 PM
- **Repeat**: Daily

---

## Step 4 — Test the connection

### Option A — Test from within the app

After configuring the webhook, tap **Test** or **Send Now** in the automation settings.
Then trigger a manual poll on the Pi to confirm it was picked up:

```bash
cd ~/projects/health-data-hub
HEALTH_ENV=prod .venv/bin/python -m health_data_hub.integrations.apple_health.nutrition_poller
```

Expected log line:
```
Nutrition upserted for 2026-03-24: 2150 kcal
```

### Option B — Manual curl test

```bash
curl -X POST https://health.michaelfigari.com/health \
     -H "Content-Type: application/json" \
     -H "X-Health-Token: $(grep HEALTH_TOKEN ~/.config/health-data-hub/prod.env | cut -d= -f2)" \
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
{"status": "ok", "date": "2026-03-24"}
```

### Option C — Verify in the database

```bash
psql -U postgres -d health_pi -c "SELECT * FROM nutrition_daily WHERE day = '2026-03-24';"
```

---

## Data flow summary

```
iPhone (Health Auto Export)
  → nightly POST at 9:30 PM
  → https://health.michaelfigari.com/health   (Cloudflare Worker)
  → stores in KV store

Pi (health-data-hub.service / scheduler_all.py)
  → nutrition_poller runs hourly (6am–midnight)
  → GET https://health.michaelfigari.com/health/latest
  → upserts into nutrition_daily (PostgreSQL)
  → notion-reporter reads nutrition_daily each morning
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `401` from Worker | Missing or wrong token header | Check `X-Health-Token` value matches `HEALTH_TOKEN` in prod.env |
| `404` from Worker on GET /latest | No data has been POSTed yet | Send a test POST from the app or via curl |
| Poller logs "Nutrition already present" | Date already in DB | Normal — no action needed |
| Morning report shows nutrition missing | Poller hasn't run since last POST | Run poller manually (Option A above) |
| Energy in kJ instead of kcal | App configured to use kJ | The Worker converts automatically; or switch app units to kcal |
