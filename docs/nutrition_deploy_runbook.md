# Nutrition logging: deploy runbook (live steps)

Run these by hand, in order, after the branch is merged. Nothing here happens in
the build run. Migration files live in `health_data_hub/db/migrations/`:

- `2026-11_00_migration_ledger.sql`
- `2026-11_01_food_log.sql`
- `2026-11_02_nutrition_daily_view.sql`

Each migration refuses to run twice (it checks `schema_migrations`) and has a
`.down.sql` beside it.

Ordering constraints:

- The retired nutrition poller (T10 code) must be deployed before migration 02
  is applied, so no 22:00 job writes to `nutrition_daily` once it is a view.
- Migration 02 must be applied on the Pi before the new code is deployed:
  `run_all.py` calls `init_db`, and `schema.sql` fails on a database without 02.

These two pull in opposite directions, so stop `health-data-hub` and pull the code (step 2),
migrate (step 3), then restart both services (step 6). The old
poller never runs against the migrated database.

## 1. Backup

```bash
pg_dump -U postgres -Fc -d health_pi -f ~/backups/health_pi_$(date +%F_%H%M)_pre-nutrition.dump
pg_restore --list <that file> | grep -c 'TABLE DATA'     # sanity check
scp <that file> <off-Pi destination>                      # an off-Pi copy
```

Do not continue until the off-Pi copy exists.

## 2. Stop the pipeline service

```bash
sudo systemctl stop health-data-hub
git pull
```

The pull puts the migration files (and the new code) on the host. `health-data-hub`
is stopped, so the old poller cannot run. `health-mcp` keeps running its
already-loaded old code until it is restarted in step 6.

## 3. Apply migrations 00 to 02

As the `postgres` role, from the repo checkout, one file at a time and in order:

```bash
psql -U postgres -d health_pi -v ON_ERROR_STOP=1 --single-transaction -f health_data_hub/db/migrations/2026-11_00_migration_ledger.sql
psql -U postgres -d health_pi -v ON_ERROR_STOP=1 --single-transaction -f health_data_hub/db/migrations/2026-11_01_food_log.sql
psql -U postgres -d health_pi -v ON_ERROR_STOP=1 --single-transaction -f health_data_hub/db/migrations/2026-11_02_nutrition_daily_view.sql
```

Check: `SELECT name FROM schema_migrations;` lists all three, and
`SELECT count(*) FROM nutrition_daily;` still returns the original day count.

## 4. Set the `nutrition_writer` password

Migration 01 creates the role without a password. Pick a long random one:

```sql
ALTER ROLE nutrition_writer PASSWORD '<new password>';
```

## 5. Configure `health-mcp.env`

In `/home/mike/.config/health-mcp/health-mcp.env` (mode `600`) add:

```
WRITE_TOOLS_ENABLED=true
DB_WRITER_USER=nutrition_writer
DB_WRITER_PASSWORD=<the password from step 4>
```

Optional: `WRITE_RATE_LIMIT_PER_HOUR` (default 120).

## 6. Deploy the code and restart

The code was pulled in step 2.

```bash
cd health-mcp && npm ci
sudo systemctl restart health-mcp
sudo systemctl restart health-data-hub
```

This deploys the code in which the `nutrition_poller` job is removed from
`scheduler_all.py` and its modules are archived. Check
`journalctl -u health-mcp -n 50` and `journalctl -u health-data-hub -n 50` for
clean starts.

## 7. Turn off the Health Auto Export nutrition export

In the Health Auto Export app, disable the nutrition export. The Cloudflare
Worker is left as is.

**Status (2026-10-25):** done. Steps 1-7 deployed on the Pi; step 8 pending.

## 8. End-to-end checklist

From claude.ai mobile, and from Claude Code using the static key:

- [ ] "I had 2 eggs and toast for breakfast": Claude shows a table first and
      writes nothing; after you agree, rows appear and are visible via `query`.
- [ ] The same works from Claude Code with the static key.
- [ ] `get_day_summary` matches `SELECT ... FROM food_log_daily`.
- [ ] `journalctl -u health-mcp` shows the write audit lines (`"evt":"write"`).
- [ ] The existing `query` tool still returns workouts.
- [ ] Corrections: update an entry, delete it, restore it.
- [ ] A day with `food_log` rows shows `source='food_log'` in `nutrition_daily`;
      soft-deleting them brings the legacy row back.
- [ ] A legacy-only day in `nutrition_daily` is unchanged.
- [ ] `export_daily_json.py` and the notion-reporter nutrition query still run.
- [ ] `health-data-hub` started cleanly (`init_db` succeeded).

## 9. Rollback ladder (least to most invasive)

1. **Bad tool behavior:** set `WRITE_TOOLS_ENABLED=false` in `health-mcp.env` and
   restart `health-mcp`. The write tools disappear and reads keep working.
2. **Bad writes:** `food_log_audit` holds every earlier version. Restore a row with
   `UPDATE food_log ... FROM food_log_audit` as `postgres`, or use
   `delete_log_entry` with `restore=true` for soft deletes.
3. **Bad server release (health-mcp only):** check out the previous tag for
   `health-mcp/` only (`git checkout <previous tag> -- health-mcp`), then `npm ci`
   and restart `health-mcp`. Do not check out an older tag across the whole repo
   while migration 02 is applied: it brings back the `nutrition_poller` in
   `health-data-hub`, which would then write to the `nutrition_daily` view. If
   `health-data-hub` is also being rolled back, run the 02 down script first
   (ladder item 4).
4. **Bad view:** run `2026-11_02_nutrition_daily_view.down.sql`.
   `nutrition_daily` is a table again with all original rows, and `food_log` is
   untouched. Readers then miss new days until the fix lands.
5. **Bad schema:** run the down script for 01 only after 02's down script. It
   refuses to run while `food_log` has rows, so dump `food_log` first, and clear
   it only if you accept losing the data.
6. **Disaster:** `pg_restore` the step 1 dump into a fresh database and swap.

Run down scripts in reverse order (02, then 01, then 00), each with
`psql -v ON_ERROR_STOP=1 --single-transaction -f`.
