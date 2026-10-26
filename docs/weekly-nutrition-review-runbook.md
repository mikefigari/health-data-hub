# Weekly nutrition review: post-merge runbook (Pi)

Run these by hand, in order, on the Pi after the branch is merged to `main`.
Nothing here happens in the build run. The reporter reads its secrets from
`notion-reporter/.env`, which is not in git and is already in place on the Pi.

The schedule after this change:

- Weekly review: Monday 06:00 `America/Los_Angeles`, prior Monday to Sunday.
- Thursday check-in: Thursday 06:00 `America/Los_Angeles`. It posts to Notion
  only when the week is off track.
- The daily briefing (10:00) is unchanged.

Paths below assume the repo is checked out at `~/health_data_hub`. Adjust them
if it lives elsewhere, and keep the same path in the scheduled lines of step 4.

## 1. Pull the merged code

```bash
cd ~/health_data_hub
git checkout main
git pull
git log -1 --oneline
```

Check that the last commit is the merge of this branch. The reporter code and
`notion-reporter/package-lock.json` only reach the host with this pull.

## 2. Install the reporter's dependencies

Node must be 22 (see `notion-reporter/.nvmrc`). Then, from the reporter folder:

```bash
cd ~/health_data_hub/notion-reporter
node -v
npm ci
```

`npm ci` installs exactly what `package-lock.json` pins. Without this step the
new code fails at its first import.

## 3. Dry-run the weekly and check-in modes

Dry mode assembles the context and prints it. It makes no Claude or Notion
calls:

```bash
cd ~/health_data_hub/notion-reporter
REPORT_MODE=dry node index.mjs | tail -40
```

Check that the output shows a nutrition and weight section for the prior week
without errors. Then confirm the check-in path loads:

```bash
REPORT_MODE=checkin node index.mjs
```

If the Thursday check-in is run on a day that is not Thursday, it still runs and
prints its numbers. It posts to Notion only when the week is off track, so
review the output before you rely on it.

## 4. Edit the crontab

Open the crontab for the user that runs the reporter (`mike`):

```bash
crontab -e
```

Remove the old Sunday weekly line, the one that runs at `0 20 * * 0`. Keep the
daily line at `0 10 * * *` as it is. Then add the `CRON_TZ` line and the two
new entries directly below the daily line, so `CRON_TZ` does not change the
daily job's time zone:

```
# Daily briefing at 10:00 (unchanged)
0 10 * * * cd /home/mike/health_data_hub/notion-reporter && node index.mjs >> /home/mike/logs/notion-reporter-daily.log 2>&1

CRON_TZ=America/Los_Angeles
# Weekly review, Monday 06:00 Pacific
0 6 * * 1 cd /home/mike/health_data_hub/notion-reporter && REPORT_MODE=weekly node index.mjs >> /home/mike/logs/notion-reporter-weekly.log 2>&1
# Thursday check-in, 06:00 Pacific (posts only when off track)
0 6 * * 4 cd /home/mike/health_data_hub/notion-reporter && REPORT_MODE=checkin node index.mjs >> /home/mike/logs/notion-reporter-checkin.log 2>&1
```

Confirm the result and that the old Sunday line is gone:

```bash
crontab -l | grep notion-reporter
crontab -l | grep -c '0 20 \* \* 0'     # expect 0
mkdir -p /home/mike/logs
```

Check the Pi's `node` path with `which node`. If it is not `/usr/bin/node`, cron
needs the full path in each line, as the daily line already assumes `node` is on
its PATH.

## 5. Check the first scheduled run

The next weekly run is the following Monday at 06:00 Pacific. The next check-in
is the following Thursday at 06:00 Pacific. After each one:

```bash
tail -40 /home/mike/logs/notion-reporter-weekly.log
tail -40 /home/mike/logs/notion-reporter-checkin.log
```

A clean run ends without a stack trace. The weekly report appears in the
Health Intelligence database. The check-in writes nothing on an on-track week.

## Rollback

1. In `crontab -e`, delete the `CRON_TZ` line and the two new entries, then
   restore the old line: `0 20 * * 0 cd /home/mike/health_data_hub/notion-reporter && REPORT_MODE=weekly node index.mjs >> /home/mike/logs/notion-reporter-weekly.log 2>&1`.
2. To return the code to the previous version, check out the previous commit
   for `notion-reporter/` only (`git checkout <previous commit> -- notion-reporter`),
   then run `npm ci` in `notion-reporter`. Do not roll back `health-mcp` or the
   database as part of this change.
