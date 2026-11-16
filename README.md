# health-data-hub

A personal health and performance data platform that consolidates training, recovery, and lifestyle signals into a unified PostgreSQL data model.

The system ingests data from sources like Strava and Oura via automated ETL pipelines, maintains an idempotent historical record, and is designed to generate meaningful daily and weekly summaries for analysis and AI-assisted coaching.

The goal is not raw data collection, but structured feedback loops that support better decisions around training load, recovery, nutrition, and long-term health.


## Components

| Component | Purpose | Docs |
|---|---|---|
| `health_data_hub/` | Python ETL: extract, load and transform for Strava, Oura, Notion and Renpho body data into PostgreSQL (`db/` holds the schema and migrations) | [docs/health_auto_export_setup.md](docs/health_auto_export_setup.md) |
| `scheduler_all.py` | Single scheduler process that runs the pollers and daily jobs (`health-data-hub.service`) | [health-data-hub.service](health-data-hub.service) |
| `health-mcp/` | MCP server giving Claude read access to the database and food logging (`log_food`, favorites) | [health-mcp/README.md](health-mcp/README.md), [docs/nutrition_logging.md](docs/nutrition_logging.md) |
| `notion-reporter/` | Morning and weekly Notion reports built from the daily data | [docs/weekly-nutrition-review-runbook.md](docs/weekly-nutrition-review-runbook.md) |
| `dashboard/` | Node service serving the weight, nutrition and FTP dashboard embedded in Notion | [dashboard/README.md](dashboard/README.md) |
| `cloudflare-worker/` | Worker that receives Health Auto Export webhooks (nutrition, body) into KV | [docs/health_auto_export_setup.md](docs/health_auto_export_setup.md) |

Deploy notes for nutrition logging: [docs/nutrition_deploy_runbook.md](docs/nutrition_deploy_runbook.md).

## Tests

Python (repo root):

```bash
venv/Scripts/python -m pytest -q
```

Node services (run in each directory):

```bash
cd health-mcp && npm test
cd notion-reporter && npm test
cd dashboard && npm test
cd cloudflare-worker && npm test
```
