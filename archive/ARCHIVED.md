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

## Safe to delete?

Yes, once you are satisfied that `notion-reporter` meets all your needs.
Keep these files as long as you want a plain-text fallback or a quick
way to run a manual one-off briefing without the Notion integration.
