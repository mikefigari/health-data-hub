# Health Auto Export — Setup Guide

This guide configures the **Health Auto Export** iOS app (by Gregory Chicote) to push
Apple Health nutrition data to the Cloudflare Worker, which the Pi poller then pulls
nightly at 22:00. A second automation pushes Renpho body measurements (weight, body
fat, lean mass, BMI) to a separate endpoint — see
[Body measurements automation](#body-measurements-automation).

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
| Dietary Energy Consumed | `HKQuantityTypeIdentifierDietaryEnergyConsumed` | must be kcal — the Worker does **not** convert kJ |
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

## Body measurements automation

Renpho scale → Renpho app → Apple Health → Health Auto Export → Worker → Pi.
This is a **separate** automation from the nutrition one above; the nutrition
`POST /health` endpoint is unchanged.

1. Health Auto Export → **Automations** → **Add Automation** → **REST API / Webhook**.
   Name it **Hub – Body**.
2. Set:
   - **URL**: `https://health.michaelfigari.com/health/body`
   - **Method**: POST
   - **Format**: JSON
   - **Header**: `X-Health-Token` = *(the `HEALTH_TOKEN` value from prod.env)*
3. **Data types**: select only the body types —
   **Weight / Body Mass**, **Body Fat Percentage**, **Lean Body Mass**, **Body Mass Index**.
   Do not add nutrition or workout types here.
4. **Data range**: **Last 7 days**. Overlapping payloads are fine; the Pi de-duplicates
   on the weigh-in timestamp.
5. **Aggregation**: individual samples if offered (daily aggregates also work — one
   weigh-in per day is assumed).
6. **Schedule**: daily, any time after the usual morning weigh-in (more often is fine).

**Full-history backfill (one-off).** Either run the Hub – Body automation once with the
data range covering the whole history (the Pi ingests it automatically, as long as the
payload is under 20 MB), or export the same body types to a JSON file in Health Auto
Export, copy it to `~/projects/data/body/backfill/` on the Pi, and run:

```bash
cd ~/projects/health-data-hub
.venv/bin/python backfill_body_measurements.py ~/projects/data/body/backfill/<file>.json --dry-run
.venv/bin/python backfill_body_measurements.py ~/projects/data/body/backfill/<file>.json
```

**Checking it on the Pi:**

```bash
cd ~/projects/health-data-hub
.venv/bin/python -m health_data_hub.integrations.apple_health.body_poller --dry-run --days-back 30
psql -U postgres -d health_pi -c "SELECT * FROM body_weight_daily ORDER BY day DESC LIMIT 7;"
```

How it is stored:

- `POST /health/body` stores each payload raw in KV under `body:<received_at>:<id>`
  (30-day expiry). `GET /health/body?since=YYYY-MM-DD` returns them.
- `body_poller` (in `scheduler_all.py`, hourly at :20, 6 AM – 11 PM) parses the payloads,
  converts lb to kg, and upserts one row per weigh-in into `body_measurements`.
- The `body_weight_daily` view takes the first weigh-in of each day; the daily export and
  notion-reporter use it for `nutrition.weight_kg`.

---

## Data flow summary

```
iPhone (Health Auto Export)
  → nutrition automation: nightly POST at 9:30 PM
      → https://health.michaelfigari.com/health        (Cloudflare Worker)
      → stores nutrition:<date> in KV
  → "Hub – Body" automation: daily POST
      → https://health.michaelfigari.com/health/body   (Cloudflare Worker)
      → stores the raw payload as body:<received_at>:<id> in KV

Pi (health-data-hub.service / scheduler_all.py)
  → nutrition_poller runs nightly at 22:00
      → GET https://health.michaelfigari.com/health/latest
      → upserts into nutrition_daily (PostgreSQL)
  → body_poller runs hourly at :20 (6am–11pm)
      → GET https://health.michaelfigari.com/health/body?since=<10 days ago>
      → upserts into body_measurements; body_weight_daily view = first weigh-in per day
  → notion-reporter reads nutrition_daily + body_weight_daily each morning
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `401` from Worker | Missing or wrong token header | Check `X-Health-Token` value matches `HEALTH_TOKEN` in prod.env |
| `404` from Worker on GET /latest | No data has been POSTed yet | Send a test POST from the app or via curl |
| Poller logs "Nutrition already present" | Date already in DB | Normal — no action needed |
| Morning report shows nutrition missing | Poller hasn't run since last POST | Run poller manually (Option A above) |
| Energy in kJ instead of kcal | App configured to use kJ | The Worker does not convert kJ — switch the app's energy unit to kcal |
| No rows in `body_measurements` | Hub – Body automation not posting, or unrecognised metric names | Run `body_poller --dry-run --days-back 30` and look for "Skipping unknown body metric" warnings |
