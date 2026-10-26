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

## 3. Dry-run the daily path

Dry mode assembles the daily briefing context and prints it. It makes no Claude
or Notion calls. It only exercises the daily path, so there is no weekly dry run.

```bash
cd ~/health_data_hub/notion-reporter
REPORT_MODE=dry node index.mjs | tail -40
```

Check that the output is the daily prompt without errors. It has no prior-week
nutrition or weight section, because dry mode does not build one.

Do not test the check-in mode by hand. `REPORT_MODE=checkin` posts a live page to
the production Notion database when the week is off track. Run it only on a
Thursday, or skip it and check the first scheduled check-in in step 5. Running it
on any other day uses an unusual Monday to Wednesday window.

## 4. Edit the crontab

First check the Pi's own time zone. Cron on Debian and Raspberry Pi OS (vixie
cron) may ignore `CRON_TZ`, in which case the 06:00 lines run in the system time
zone:

```bash
timedatectl | grep "Time zone"
```

Expect `America/Los_Angeles`. If it shows another zone, set it:

```bash
sudo timedatectl set-timezone America/Los_Angeles
```

This also changes the wall-clock time of the daily 10:00 briefing, which will
then run at 10:00 Pacific. If you do not want that, leave the system zone as it
is and check the time the first run in step 5 actually fires.

Open the crontab for the user that runs the reporter (`mike`):

```bash
crontab -e
```

Remove every existing weekly-reporter line: any line containing `REPORT_MODE=weekly`
or `npm run weekly`, whatever its schedule. The old Sunday line at `0 20 * * 0`
is the expected one. An earlier setup may
have left a different weekly line, such as a Monday `npm run weekly` entry with
`/home/pi` paths, so remove that too. Keep the daily line at `0 10 * * *` as it
is. Then add the `CRON_TZ` line and the two new entries directly below the daily
line, so `CRON_TZ` does not change the daily job's time zone:

```
# Daily briefing at 10:00 (unchanged)
0 10 * * * cd /home/mike/health_data_hub/notion-reporter && node index.mjs >> /home/mike/logs/notion-reporter-daily.log 2>&1

CRON_TZ=America/Los_Angeles
# Weekly review, Monday 06:00 Pacific
0 6 * * 1 cd /home/mike/health_data_hub/notion-reporter && REPORT_MODE=weekly node index.mjs >> /home/mike/logs/notion-reporter-weekly.log 2>&1
# Thursday check-in, 06:00 Pacific (posts only when off track)
0 6 * * 4 cd /home/mike/health_data_hub/notion-reporter && REPORT_MODE=checkin node index.mjs >> /home/mike/logs/notion-reporter-checkin.log 2>&1
```

Confirm the result and that exactly one weekly line remains:

```bash
crontab -l | grep notion-reporter
crontab -l | grep -c weekly     # expect 1
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
   If you changed the system time zone in step 4, set it back with
   `sudo timedatectl set-timezone <previous zone>`.
2. To return the code to the previous version, check out the previous commit
   for `notion-reporter/` only (`git checkout <previous commit> -- notion-reporter`),
   then run `npm ci` in `notion-reporter`. Do not roll back `health-mcp` or the
   database as part of this change.
