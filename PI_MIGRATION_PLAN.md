# Health Data Hub — Raspberry Pi 5 Migration Plan

> **Legend:** `[WIN]` = run on Windows PC · `[PI]` = run on Raspberry Pi · `[BOTH]` = applies to both

---

## Phase 0 — Safety Net (read before starting anything)

**The Windows system must keep running throughout the entire migration. Do not stop the Windows scheduler until Phase 8 is fully validated.** If the Pi fails at any point, you fall back to Windows immediately — no recovery steps needed, just leave Windows alone.

### 0.1 — Confirm the Windows scheduler is running

```powershell
# Check if scheduler_all.py is running
Get-Process python | Select-Object Id, CPU, StartTime
# or
tasklist | findstr python
```

If it's not running, start it now before proceeding:

```powershell
cd "C:\Users\figar\Documents\PARA Personal\01 Projects\Programming\health_data_hub"
start /B venv\Scripts\python scheduler_all.py > logs\scheduler.log 2>&1
```

### 0.2 — Bookmark the Windows restart procedure

If migration fails and you need to confirm Windows is operational:

```powershell
# 1. Kill any orphaned python processes
taskkill /F /IM python.exe

# 2. Restart the scheduler
cd "C:\Users\figar\Documents\PARA Personal\01 Projects\Programming\health_data_hub"
start /B venv\Scripts\python scheduler_all.py > logs\scheduler.log 2>&1

# 3. Confirm it's running and polling
#    Wait ~5 min, then check the log for "Poll cycle complete"
type logs\scheduler.log
```

### 0.3 — Cutover rule

**Only stop the Windows scheduler after:**
- Phase 8 validation passes for all integrations (Strava, Oura, Notion, MFP)
- The Pi scheduler has run at least one Strava poll cycle cleanly
- You are satisfied the Pi is stable

Both systems running in parallel briefly is safe — all pollers use upsert semantics, so duplicate writes are harmless.

---

## Phase 1 — Windows Prep

Do all of this **before you touch the Pi**. Goal: freeze everything that needs to transfer cleanly.

---

### 1.1 — Complete prod.env

`prod.env` has been partially populated. The following variables still have `FILL_IN` placeholders — fill them in from `dev.env` or your credential store **before copying it to the Pi**:

| Variable | Source |
|---|---|
| `DB_PASSWORD` | The password you'll set for postgres on the Pi (decide now) |
| `STRAVA_CLIENT_ID` | Your `dev.env` → `STRAVA_CLIENT_ID` |
| `STRAVA_CLIENT_SECRET` | Your `dev.env` → `STRAVA_CLIENT_SECRET` |
| `OURA_PERSONAL_ACCESS_TOKEN` | Your `dev.env` → `OURA_PERSONAL_ACCESS_TOKEN`, or https://cloud.ouraring.com/personal-access-tokens |
| `MFP_USERNAME` | Your MyFitnessPal username |

All other variables (Notion tokens/IDs, Anthropic API key, Strava redirect URI, DB host) are already populated correctly.

```powershell
notepad health_data_hub\config\prod.env
```

Verify no `FILL_IN` remains:

```powershell
findstr "FILL_IN" health_data_hub\config\prod.env
# Should return nothing
```

---

### 1.2 — Pin Python package versions

Run this from the repo root in your active venv:

```powershell
venv\Scripts\pip freeze > requirements.pinned.txt
```

Commit the result:

```powershell
git add requirements.pinned.txt
git commit -m "chore: pin Python dependencies for Pi migration"
git push
```

The Pi will install from `requirements.pinned.txt`, not `requirements.txt`, to guarantee identical versions.

---

### 1.3 — Record Node.js version

```powershell
node --version
```

Write that version (e.g., `v22.11.0`) into a file:

```powershell
node --version > notion-reporter\.nvmrc
```

Commit it:

```powershell
git add notion-reporter\.nvmrc
git commit -m "chore: pin Node.js version for Pi migration"
git push
```

---

### 1.4 — Final row-count verification

Connect to Postgres and confirm counts match expectations before dumping:

```sql
SELECT
    relname AS table_name,
    n_live_tup AS approx_rows
FROM pg_stat_user_tables
ORDER BY relname;
```

Expected values to confirm before proceeding:

| Table | Expected rows |
|---|---|
| workouts_raw | 807 |
| workout_summary | 807 |
| workout_samples | ~1,793,049 |
| oura_sleep_raw | 200 |
| oura_readiness_raw | 150 |
| oura_activity_raw | 151 |
| oura_hr_samples | ~15,159 |
| daily_physical_state | 32 |
| nutrition_daily | 21 |
| planned_workouts | 6 |
| ftp_history | 0 (seed manually in Phase 5) |

---

### 1.5 — Full pg_dump

This captures all tables, views, indexes, constraints, triggers, functions, and sequences in a single compressed archive.

```powershell
pg_dump -U postgres -d health -F c -f health_backup_20260319.dump
```

Verify the dump is non-zero and readable:

```powershell
pg_restore --list health_backup_20260319.dump | head -50
```

You should see entries for tables, sequences, views, triggers, and the `set_updated_at()` function.

---

### 1.6 — Export MFP cookies

Make sure you are currently logged in to myfitnesspal.com in Chrome or Firefox, then:

```powershell
venv\Scripts\python -m health_data_hub.integrations.mfp.mfp_auth
```

This writes `health_data_hub\config\mfp_cookies.txt`. The file is gitignored — do not commit it.

---

### 1.7 — Assemble transfer bundle

Create a staging folder and copy all files that cannot go through git:

```powershell
mkdir C:\transfer\hdh

# Database dump
copy health_backup_20260319.dump C:\transfer\hdh\

# Strava OAuth tokens (already have valid refresh_token — headless refresh will work)
copy health_data_hub\config\strava_tokens.json C:\transfer\hdh\

# MFP cookies
copy health_data_hub\config\mfp_cookies.txt C:\transfer\hdh\

# prod.env — must have no FILL_IN values remaining (see 1.1) before copying
copy health_data_hub\config\prod.env C:\transfer\hdh\
```

Transfer to Pi over your local network:

```bash
# From Windows using scp:
scp C:\transfer\hdh\* pi@raspberrypi.local:~/hdh_transfer/

# Or from the Pi (pulling from a Windows share):
scp user@windows-pc:C:/transfer/hdh/* ~/hdh_transfer/
```

---

## Phase 2 — Pi OS & Hardware Setup

### 2.1 — Identify and mount the USB SSD

```bash
# List block devices to find your SSD (look for /dev/sda or /dev/sdb)
lsblk -f

# If not yet formatted, format it (WARNING: destroys existing data)
sudo mkfs.ext4 /dev/sda1

# Create mount point
sudo mkdir -p /mnt/ssd

# Mount temporarily to verify
sudo mount /dev/sda1 /mnt/ssd
df -h /mnt/ssd
```

Get the UUID for persistent mounting:

```bash
sudo blkid /dev/sda1
# Note the UUID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Add to `/etc/fstab` for auto-mount at boot:

```bash
sudo nano /etc/fstab
# Add this line (replace UUID):
UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  /mnt/ssd  ext4  defaults,noatime  0  2
```

Test it:

```bash
sudo mount -a   # should not error
```

---

### 2.2 — Install system packages

```bash
sudo apt update && sudo apt upgrade -y

sudo apt install -y \
    git \
    python3 python3-pip python3-venv \
    postgresql postgresql-contrib \
    curl \
    build-essential \
    libpq-dev \
    libssl-dev \
    libffi-dev
```

---

### 2.3 — Move PostgreSQL data directory to the SSD

**This prevents SD card wear from high-write workloads (workout_samples is 1.8M rows).**

```bash
# Stop Postgres
sudo systemctl stop postgresql

# Copy existing cluster to SSD (preserves permissions)
sudo rsync -av /var/lib/postgresql/ /mnt/ssd/postgresql/

# Rename original as backup (do NOT delete yet)
sudo mv /var/lib/postgresql /var/lib/postgresql.bak

# Point Postgres at the SSD location
sudo nano /etc/postgresql/*/main/postgresql.conf
# Change:  data_directory = '/var/lib/postgresql/*/main'
# To:      data_directory = '/mnt/ssd/postgresql/*/main'

# Start Postgres
sudo systemctl start postgresql
sudo systemctl status postgresql

# Verify it's running from SSD
sudo -u postgres psql -c "SHOW data_directory;"
# Should show: /mnt/ssd/postgresql/*/main

# Once confirmed working, delete the backup
sudo rm -rf /var/lib/postgresql.bak
```

---

### 2.4 — Install Node.js at the pinned version

Read the version from `.nvmrc` (committed in Phase 1). Install via NodeSource:

```bash
# Check what version you pinned
cat ~/health_data_hub/notion-reporter/.nvmrc
# e.g. v22.11.0  →  major version 22

# Install NodeSource repo for that major version
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version   # should match .nvmrc
npm --version
```

---

## Phase 3 — Database Restore

### 3.1 — Create database and user

```bash
sudo -u postgres psql <<'SQL'
CREATE DATABASE health;
-- If you want a dedicated user instead of using postgres directly:
-- CREATE USER health_user WITH PASSWORD 'yourpassword';
-- GRANT ALL PRIVILEGES ON DATABASE health TO health_user;
SQL
```

---

### 3.2 — Restore the dump

```bash
pg_restore \
    -U postgres \
    -d health \
    --no-owner \
    --role=postgres \
    -v \
    ~/hdh_transfer/health_backup_20260319.dump \
    2>&1 | tee ~/hdh_transfer/restore.log
```

`--no-owner` prevents errors if the Pi's Postgres user differs. The `-v` output will show every object being created.

Check for errors:

```bash
grep -i "error\|failed" ~/hdh_transfer/restore.log | grep -v "^pg_restore: warning"
```

---

### 3.3 — Verify row counts post-restore

```bash
sudo -u postgres psql -d health -c "
SELECT relname AS table_name, n_live_tup AS approx_rows
FROM pg_stat_user_tables
ORDER BY relname;"
```

Confirm counts match Phase 1.3.

Verify views and trigger exist:

```bash
sudo -u postgres psql -d health -c "\dv"        # should list analysis_daily_rollup_10d, notion_workouts_view
sudo -u postgres psql -d health -c "\df"        # should list set_updated_at()
sudo -u postgres psql -d health -c "\dy"        # should list trg_daily_physical_state_updated
```

---

### 3.4 — Seed ftp_history

FTP history is empty but needed for TSS/IF calculations. Insert your current FTP:

```bash
sudo -u postgres psql -d health <<'SQL'
INSERT INTO ftp_history (effective_date, ftp_watts, notes)
VALUES ('2024-01-01', 250, 'Initial seed — update with your actual FTP and date');
SQL
```

Replace `2024-01-01` with the date your current FTP became effective and `250` with your actual FTP in watts. Add additional historical rows if you have them.

---

## Phase 4 — Python Environment

### 4.1 — Clone the repo

```bash
cd ~
git clone git@github.com:<your-username>/health_data_hub.git
# or HTTPS:
git clone https://github.com/<your-username>/health_data_hub.git

cd health_data_hub
git checkout main
```

---

### 4.2 — Create venv and install pinned dependencies

```bash
python3 -m venv venv
venv/bin/pip install --upgrade pip
venv/bin/pip install -r requirements.pinned.txt
```

Verify the install:

```bash
venv/bin/python -c "import psycopg2; import anthropic; import apscheduler; print('OK')"
```

**Note:** `browser_cookie3` is NOT in requirements and should NOT be installed on the Pi.
`mfp_auth.py` Tier 2 (live browser fallback) will gracefully fail with a clear error message if cookies are missing — it won't crash the import.

---

### 4.3 — Copy credentials into place

```bash
# prod.env
cp ~/hdh_transfer/prod.env ~/health_data_hub/health_data_hub/config/prod.env

# Strava tokens
cp ~/hdh_transfer/strava_tokens.json ~/health_data_hub/health_data_hub/config/strava_tokens.json

# MFP cookies
cp ~/hdh_transfer/mfp_cookies.txt ~/health_data_hub/health_data_hub/config/mfp_cookies.txt

# Protect the files
chmod 600 ~/health_data_hub/health_data_hub/config/prod.env
chmod 600 ~/health_data_hub/health_data_hub/config/strava_tokens.json
chmod 600 ~/health_data_hub/health_data_hub/config/mfp_cookies.txt
```

---

### 4.4 — Smoke test the Python stack

```bash
cd ~/health_data_hub
HEALTH_ENV=prod venv/bin/python -c "
from health_data_hub.config.settings import DB_HOST, STRAVA_CLIENT_ID, OURA_PERSONAL_ACCESS_TOKEN, ANTHROPIC_API_KEY, NOTION_TOKEN
assert all([DB_HOST, STRAVA_CLIENT_ID, OURA_PERSONAL_ACCESS_TOKEN, ANTHROPIC_API_KEY, NOTION_TOKEN]), 'Missing env vars!'
print('All required settings loaded OK')
"

# Test DB connection
HEALTH_ENV=prod venv/bin/python -c "
from health_data_hub.utils.db_connect import get_connection
conn = get_connection()
cur = conn.cursor()
cur.execute('SELECT COUNT(*) FROM workouts_raw')
print('workouts_raw count:', cur.fetchone()[0])
conn.close()
"
```

---

## Phase 5 — Node.js (notion-reporter) Setup

### 5.1 — Install dependencies

```bash
cd ~/health_data_hub/notion-reporter
npm install
```

---

### 5.2 — Configure .env

```bash
cp .env.example .env
nano .env
```

Fill in all values (see `.env.example` for the full list). Required fields:

```ini
DB_HOST=localhost
DB_PORT=5432
DB_NAME=health
DB_USER=postgres
DB_PASSWORD=<same as prod.env>

ANTHROPIC_API_KEY=<same as prod.env>

NOTION_TOKEN=<same as prod.env>
NOTION_HEALTH_INTELLIGENCE_DB_ID=<your health intelligence DB ID>
NOTION_WORKOUT_DB_ID=<same as prod.env>
NOTION_DAILY_STATE_DB_ID=<same as prod.env>

REPORT_MODE=daily
```

Protect it:

```bash
chmod 600 .env
```

---

### 5.3 — Smoke test notion-reporter

```bash
cd ~/health_data_hub/notion-reporter

# Dry run — assembles context and prints the prompt without calling Claude or posting to Notion
REPORT_MODE=dry node index.mjs
```

Output should show the assembled health context without errors.

---

## Phase 6 — Systemd Service (scheduler_all.py)

### 6.1 — Create the service unit file

```bash
sudo nano /etc/systemd/system/health-hub.service
```

Paste:

```ini
[Unit]
Description=Health Data Hub Unified Scheduler
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/health_data_hub
Environment=HEALTH_ENV=prod
ExecStart=/home/pi/health_data_hub/venv/bin/python scheduler_all.py
Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

---

### 6.2 — Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable health-hub.service
sudo systemctl start health-hub.service

# Verify it started
sudo systemctl status health-hub.service

# Watch live logs
sudo journalctl -u health-hub.service -f
```

You should see the scheduler startup message:

```
Unified scheduler starting — Strava every 5 min, Oura daily at 07:00, ...
```

And within 5 minutes, the first Strava poll cycle should complete.

---

## Phase 7 — Cron Jobs (notion-reporter)

### 7.1 — Create log directory

```bash
mkdir -p ~/logs
```

### 7.2 — Add crontab entries

```bash
crontab -e
```

Add:

```cron
# notion-reporter — daily report at 06:00
0 6 * * * cd /home/pi/health_data_hub/notion-reporter && npm run daily >> /home/pi/logs/notion-reporter-daily.log 2>&1

# notion-reporter — weekly report on Monday at 08:00
0 8 * * 1 cd /home/pi/health_data_hub/notion-reporter && npm run weekly >> /home/pi/logs/notion-reporter-weekly.log 2>&1
```

Adjust times to match your preferred schedule.

---

## Phase 8 — End-to-End Validation

Run each integration once manually before relying on the scheduler.

### 8.1 — Strava

```bash
cd ~/health_data_hub
HEALTH_ENV=prod venv/bin/python -c "
from health_data_hub.integrations.poll_strava import poll_once
poll_once()
"
```

Expected output: "No new workouts found." (or processes a new one if you worked out recently).

### 8.2 — Oura

```bash
HEALTH_ENV=prod venv/bin/python -c "
from health_data_hub.integrations.oura.poll_oura import poll_oura
poll_oura(days_back_sleep=3, days_back_activity=1)
"
```

### 8.3 — Notion Daily State

```bash
HEALTH_ENV=prod venv/bin/python -c "
from health_data_hub.integrations.notion.poll_notion_daily_state import poll_notion_daily_state
poll_notion_daily_state(days_back=3)
"
```

### 8.4 — MFP

```bash
HEALTH_ENV=prod venv/bin/python -c "
from health_data_hub.integrations.mfp.poll_mfp import poll_mfp
poll_mfp(days_back=3)
"
```

### 8.5 — notion-reporter dry run

```bash
cd ~/health_data_hub/notion-reporter
REPORT_MODE=dry node index.mjs
```

### 8.6 — Final scheduler status check

```bash
sudo systemctl status health-hub.service
sudo journalctl -u health-hub.service --since "1 hour ago"
```

---

## Ongoing Maintenance

### MFP cookie refresh (every 30–90 days)

When MFP polling starts returning auth errors:

1. On Windows, log in to myfitnesspal.com in Chrome or Firefox.
2. Run: `venv\Scripts\python -m health_data_hub.integrations.mfp.mfp_auth`
3. Copy to Pi: `scp health_data_hub\config\mfp_cookies.txt pi@raspberrypi.local:~/health_data_hub/health_data_hub/config/`
4. The scheduler does not need to restart — `mfp_auth.py` reads the file fresh each poll cycle.

The cookie file age warning threshold is 25 days — you'll see warnings in the journal before outright failures.

### Strava token refresh

No action needed. `strava_refresh.py` handles this automatically, gated on `expires_at`.

### Log rotation

```bash
sudo nano /etc/logrotate.d/health-hub
```

```
/home/pi/logs/*.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
}
```

---

## Rollback Procedures

**The Windows system is the fallback at every phase. The Pi is being built alongside Windows, not instead of it. Rollback at any phase = stop Pi work and confirm Windows is still running.**

### If anything fails before Phase 6 (scheduler not yet started on Pi)

No action needed. Windows scheduler is still running. Diagnose the Pi failure, fix it, and retry that phase. The Windows DB is intact and untouched.

### If the Pi scheduler starts but integrations fail (Phase 8)

```bash
# Stop the Pi scheduler so it doesn't keep retrying
sudo systemctl stop health-hub.service

# On Windows — confirm scheduler is still running
tasklist | findstr python
# If not running, restart it (see Phase 0.2)
```

Debug on Pi, then restart when ready:

```bash
sudo systemctl start health-hub.service
```

### If you accidentally stop the Windows scheduler

Restart it immediately (see Phase 0.2). No data loss — APIs retain history. Strava and Oura support backfill so any activities missed during the outage can be recovered:

```powershell
# Strava backfill — on Windows, run a manual poll with a larger limit
venv\Scripts\python -c "
from health_data_hub.integrations.poll_strava import poll_once
poll_once()
"
```

Strava `poll_once()` uses `last_sync_time` from the DB, so it will automatically pick up anything missed since the last successful poll.

### If the Pi DB restore corrupts or diverges from Windows

The Windows DB is unchanged. Re-dump from Windows and re-run Phase 3 on the Pi:

```bash
# Drop and recreate the Pi DB
sudo -u postgres psql -c "DROP DATABASE health;"
sudo -u postgres psql -c "CREATE DATABASE health;"

# Re-run restore with the fresh dump
pg_restore -U postgres -d health --no-owner --role=postgres -v ~/hdh_transfer/health_backup_20260319.dump
```

### Cutover — stopping Windows after Pi is validated

Once Phase 8 passes:

```powershell
# Windows — kill the scheduler
taskkill /F /IM python.exe

# Confirm it's gone
tasklist | findstr python
```

The Pi is now the sole system. Both ran in parallel briefly — the upsert semantics mean no duplicate data was written.

---

## Checklist

### Phase 0 — Safety Net
- [ ] Windows scheduler confirmed running before starting migration
- [ ] Windows restart procedure bookmarked (Phase 0.2)

### Phase 1 — Windows Prep
- [ ] `prod.env` — no `FILL_IN` values remain (`findstr "FILL_IN" health_data_hub\config\prod.env` returns nothing)
- [ ] `requirements.pinned.txt` created and committed
- [ ] Node.js version recorded in `notion-reporter/.nvmrc` and committed
- [ ] DB row counts verified against table above
- [ ] `pg_dump` completed, output verified non-empty
- [ ] MFP cookies exported via `mfp_auth.py`
- [ ] Transfer bundle assembled and copied to Pi

### Phase 2 — Pi Hardware
- [ ] USB SSD mounted and in `/etc/fstab`
- [ ] System packages installed
- [ ] PostgreSQL data directory moved to SSD and confirmed
- [ ] Node.js installed at pinned version

### Phase 3 — Database
- [ ] `health` database created
- [ ] `pg_restore` completed, no unexpected errors
- [ ] Row counts verified post-restore
- [ ] `ftp_history` seeded

### Phase 4 — Python
- [ ] Repo cloned
- [ ] venv created and `requirements.pinned.txt` installed
- [ ] `prod.env`, `strava_tokens.json`, `mfp_cookies.txt` in place with 600 permissions
- [ ] Smoke test passes (settings + DB connection)

### Phase 5 — Node.js
- [ ] `npm install` completed
- [ ] `.env` populated and protected
- [ ] Dry run passes

### Phase 6 — Systemd
- [ ] Service unit file created
- [ ] Service enabled and started
- [ ] Startup log shows expected scheduler message

### Phase 7 — Cron
- [ ] Log directory created
- [ ] Crontab entries added for daily and weekly reports

### Phase 8 — Validation
- [ ] Strava manual poll: OK
- [ ] Oura manual poll: OK
- [ ] Notion daily state manual poll: OK
- [ ] MFP manual poll: OK
- [ ] notion-reporter dry run: OK
- [ ] Scheduler running clean in journalctl
- [ ] **Windows scheduler stopped (cutover complete)**
