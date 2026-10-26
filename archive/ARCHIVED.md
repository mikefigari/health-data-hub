# Archived Scripts

These files were moved here on 2026-03-24 during a consolidation of the
morning reporting pipeline.

## Why archived

The project had two parallel systems that both analysed health data and
called the Claude API:

| System | Language | Scheduled | Output |
|---|---|---|---|
| `notion-reporter/index.mjs` | Node.js | Yes — cron | Notion pages |
| `morning_briefing.py` | Python | No | stdout / `analysis_logs/` |
| `weekly_plan.py` | Python | No | stdout / `analysis_logs/` |

`notion-reporter` was the only system with a cron schedule and the only
one producing the Notion pages read every morning. `morning_briefing.py`
and `weekly_plan.py` were unscheduled reference implementations with no
active users.

All logic present in these files (sleep threshold flagging, deficit
adherence, kJ→kcal annotation, nutrition data gate, TDEE calculation)
is already present in `notion-reporter/src/anthropic/analyzeHealth.mjs`
and its context builders. Nothing needed to be ported.

## Files

### `morning_briefing.py`
Daily Claude analysis script. Reads PostgreSQL + Apple Health JSON store,
calls `claude-opus-4-5`, prints to stdout and optionally saves to
`analysis_logs/morning_YYYY-MM-DD.txt`. Never scheduled via cron.

### `weekly_plan.py`
Weekly Claude analysis script. Parallel to `morning_briefing.py` for
the 7-day review. Never scheduled via cron.

### `health_webhook_receiver.py`
Apple Health webhook receiver (HTTP server on port 8765). Accepted POST requests
from Health Auto Export, parsed the metrics payload, and upserted rows into
`nutrition_daily`. Replaced on 2026-03-24 by the pull-based `nutrition_poller.py`
which polls `GET https://health.michaelfigari.com/health/latest` instead.
The corresponding `health-webhook.service` systemd unit was disabled at the same time.

### `nutrition_poller.py`, `insert_nutrition_daily.py`, `lock_nutrition.py`
Archived 2026-10-25 (decision D1, nutrition logging plan). The Health Auto Export
nutrition export is turned off; nutrition is now logged through the MCP
`food_log` tools. The 22:00 `nutrition_poller` job was removed from
`scheduler_all.py`. The Cloudflare Worker is left as is. Originally under
`health_data_hub/integrations/apple_health/`, `health_data_hub/etl/load/` and the
repo root. `health_webhook_receiver.py` above imports `insert_nutrition_daily`
and no longer runs.

## Safe to delete?

Yes, once you are satisfied that `notion-reporter` meets all your needs.
Keep these files as long as you want a plain-text fallback or a quick
way to run a manual one-off briefing without the Notion integration.
