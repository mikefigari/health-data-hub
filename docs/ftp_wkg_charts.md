# FTP and W/kg charts (Datawrapper)

Two Datawrapper line charts (FTP in watts, and W/kg), embedded in Notion and
refreshed automatically by the Pi scheduler.

## Data source

- FTP: table `ftp_history` (`effective_from`, `ftp_watts`). Dates are converted
  with `AT TIME ZONE 'America/Los_Angeles'`.
- Weight: table `body_weight_daily` (`day`, `weight_kg`), fed by the body poller.
- Dataset builder: `health_data_hub/etl/transform/build_ftp_wkg.py`.
- CSV columns: `date, ftp_w, weight_kg, wkg, weight_source`. Written to
  `exports/ftp_wkg.csv` (gitignored; override with `FTP_WKG_CSV_PATH`).

## Row rules

- Rows are every weigh-in day on or after the first FTP date, plus each FTP date.
- `ftp_w` is the latest FTP on or before the row date (step function).
- On an FTP date without a weigh-in, weight is interpolated between the
  neighbouring weigh-ins (`weight_source = interpolated`); with only one
  neighbour it uses that one (`nearest`).
- `wkg = round(ftp_w / weight_kg, 2)`.
- There is no synthetic "today" row.

## Refresh schedule

Job id `ftp_wkg_charts` in `scheduler_all.py`: hourly at minute 40, 06:00-23:40,
20 minutes after `body_poller`. The CSV is hashed (SHA-256); if it is unchanged
from the last sync, no Datawrapper API calls are made. Otherwise each chart gets
PATCH (metadata), PUT data (CSV) and publish.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATAWRAPPER_API_TOKEN` | Datawrapper API token (required except for `--dry-run`) |
| `DATAWRAPPER_STATE_FILE` | Chart IDs and last CSV hash; default `~/.config/health-data-hub/datawrapper_charts.json` |
| `FTP_WKG_CSV_PATH` | CSV output path; default `exports/ftp_wkg.csv` |

## Pi setup

1. Create a Datawrapper API token with chart read/write scope.
2. Add `DATAWRAPPER_API_TOKEN=...` to the Pi's env file used by the service.
3. Restart `health-hub.service`. On the first run the job creates both charts
   and stores their IDs in the state file.
4. In Notion, embed `https://datawrapper.dwcdn.net/<chart_id>/` for each chart
   (IDs are in the state file and the job log). Chart dark mode follows the
   OS/browser setting, not Notion's toggle.

## Manual run

```
python -m health_data_hub.integrations.datawrapper.ftp_wkg_charts [--dry-run]
```

`--dry-run` writes the CSV only and makes no Datawrapper calls. Exit codes:
0 ok, 1 API/DB error, 2 token missing.

## Rebuild steps

- Force a re-sync (e.g. after changing chart styling): change detection hashes
  the CSV only, so delete the state file to force a fresh PATCH/PUT/publish.
  Note this also drops the stored chart IDs, so new charts are created and the
  Notion embeds must be updated. To keep the charts, instead edit the
  `csv_sha256` value out of the state file.
- Rebuild the dataset only: run with `--dry-run` and inspect `exports/ftp_wkg.csv`.
