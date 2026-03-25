/**
 * buildDailyContext.mjs
 *
 * Assembles the full context object for a daily report:
 *  - DB: today + 3 prior days of health data
 *  - Notion: workout page IDs, DPS page ID, PowerZone block page ID
 */

import { Client as NotionClient } from '@notionhq/client';
import { exportDays, getLastStravaSyncStatus } from './db.mjs';

const TDEE_BASELINE        = 2800;
const DEFAULT_RIDE_KJ      = 500;

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate, n) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Notion helpers ─────────────────────────────────────────────────────────

function notionClient() {
  return new NotionClient({ auth: process.env.NOTION_TOKEN });
}

/**
 * Find Notion workout page IDs for a given date.
 * Queries NOTION_WORKOUT_DB_ID filtering by "Workout Date" = targetDate.
 */
async function fetchWorkoutPageIds(targetDate) {
  const dbId = process.env.NOTION_WORKOUT_DB_ID;
  if (!dbId) {
    console.warn('[warn] NOTION_WORKOUT_DB_ID not set — skipping workout page ID fetch');
    return [];
  }

  try {
    const notion = notionClient();
    const response = await notion.databases.query({
      database_id: dbId,
      filter: {
        property: 'Workout Date',
        date: { equals: targetDate },
      },
    });
    return response.results.map(p => p.id);
  } catch (err) {
    console.warn(`[warn] Could not fetch workout pages for ${targetDate}: ${err.message}`);
    return [];
  }
}

/**
 * Find the Notion DPS page ID for a given date.
 * Queries NOTION_DAILY_STATE_DB_ID filtering by created_time range (midnight ± 1 day).
 * Falls back to a ±1-day window if nothing found on the exact date.
 */
async function fetchDpsPageId(targetDate) {
  const dbId = process.env.NOTION_DAILY_STATE_DB_ID;
  if (!dbId) {
    console.warn('[warn] NOTION_DAILY_STATE_DB_ID not set — skipping DPS page ID fetch');
    return null;
  }

  try {
    const notion   = notionClient();
    const dayStart = `${targetDate}T00:00:00.000Z`;
    const dayEnd   = `${addDays(targetDate, 1)}T00:00:00.000Z`;

    const response = await notion.databases.query({
      database_id: dbId,
      filter: {
        and: [
          { timestamp: 'created_time', created_time: { on_or_after: dayStart } },
          { timestamp: 'created_time', created_time: { before:     dayEnd   } },
        ],
      },
      page_size: 1,
    });

    if (response.results.length > 0) {
      return response.results[0].id;
    }

    console.warn(`[warn] No DPS page found for ${targetDate} (checked created_time range)`);
    return null;
  } catch (err) {
    console.warn(`[warn] Could not fetch DPS page for ${targetDate}: ${err.message}`);
    return null;
  }
}

/**
 * Find the currently active PowerZone training block page.
 * Queries NOTION_POWERZONE_DB_ID for a date property covering today.
 * Falls back to the most recently edited page if no date-range filter matches.
 */
async function fetchPowerZonePage(targetDate) {
  const dbId = process.env.NOTION_POWERZONE_DB_ID;
  if (!dbId) {
    console.warn('[warn] NOTION_POWERZONE_DB_ID not set — skipping PowerZone block fetch');
    return null;
  }

  const dateProp = process.env.NOTION_POWERZONE_DATE_PROP || 'Date';
  const notion   = notionClient();

  // Try to find a block whose date range includes targetDate
  try {
    const response = await notion.databases.query({
      database_id: dbId,
      filter: {
        and: [
          { property: dateProp, date: { on_or_before: targetDate } },
          { property: dateProp, date: { on_or_after:  targetDate } },
        ],
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 1,
    });

    if (response.results.length > 0) {
      const page = response.results[0];
      return { id: page.id, name: extractPageTitle(page) };
    }
  } catch {
    // Date-range filter may have failed (e.g. wrong property name) — fall through
  }

  // Fallback: most recently edited page
  try {
    const response = await notion.databases.query({
      database_id: dbId,
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 1,
    });

    if (response.results.length > 0) {
      const page = response.results[0];
      console.warn('[warn] PowerZone date filter failed — using most recent page as fallback');
      return { id: page.id, name: extractPageTitle(page) };
    }
  } catch (err) {
    console.warn(`[warn] Could not fetch PowerZone page: ${err.message}`);
  }

  return null;
}

function extractPageTitle(page) {
  const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
  return titleProp?.title?.[0]?.plain_text ?? 'Unknown Block';
}

// ── Data gate ─────────────────────────────────────────────────────────────

/**
 * Checks which data sources are present.
 *
 * Oura sleep and readiness are attributed to the date the sleep session STARTED
 * (the prior calendar evening), so they live in yesterdayRow — not todayRow.
 * Yesterday's nutrition diary is also fully closed and synced by 10:00, so that
 * check uses yesterdayRow as well.
 */
function buildDataGate(todayRow, yesterdayRow, lastStravaSync) {
  const sleep      = yesterdayRow?.sleep                 ?? {};
  const readiness  = yesterdayRow?.readiness             ?? {};
  const workouts   = todayRow?.workouts                  ?? [];
  const nutrition  = yesterdayRow?.nutrition             ?? {};
  const pmc        = todayRow?.performance_management    ?? {};
  const physState  = todayRow?.physical_state            ?? {};

  const oura_sleep_present     = sleep.total_sleep_sec != null;
  const oura_readiness_present = readiness.score != null;
  const strava_present         = Array.isArray(workouts) && workouts.length > 0;
  const nutrition_present      = nutrition.calories != null && nutrition.calories > 0;
  const pmc_present            = pmc.atl != null && pmc.ctl != null && pmc.tsb != null;
  const physical_state_present = physState.overall_state != null;

  // Sync health: true if a successful or no_data poll ran in the last 4 hours.
  // false means the poller is broken (token error, API error, etc.).
  const strava_sync_ok = lastStravaSync != null &&
    (lastStravaSync.status === 'success' || lastStravaSync.status === 'no_data');

  const missing_sources = [];
  if (!oura_sleep_present)     missing_sources.push('oura_sleep');
  if (!oura_readiness_present) missing_sources.push('oura_readiness');
  if (!strava_present)         missing_sources.push('strava');
  if (!nutrition_present)      missing_sources.push('nutrition');
  if (!pmc_present)            missing_sources.push('pmc');
  if (!physical_state_present) missing_sources.push('physical_state');

  return {
    oura_sleep_present,
    oura_readiness_present,
    strava_present,
    strava_sync_ok,
    strava_last_sync: lastStravaSync
      ? {
          status:              lastStravaSync.status,
          triggered_at:        lastStravaSync.triggered_at,
          activities_written:  lastStravaSync.activities_written,
          error_message:       lastStravaSync.error_message ?? null,
        }
      : null,
    nutrition_present,
    pmc_present,
    physical_state_present,
    missing_sources,
    gate_checked_at: new Date().toISOString(),
  };
}

// ── Deficit context for the daily prompt ──────────────────────────────────

/**
 * Computes calorie context using yesterday's closed nutrition diary.
 *
 * kJ resolution order (never derive from TSS in the prompt — do it here):
 *   1. Actual kJ from power meter   (kj_source = 'actual')
 *   2. TSS × 9.5 estimate           (kj_source = 'estimated from TSS')
 *   3. Athlete default 500 kJ       (kj_source = 'athlete default (500 kJ — no ride data)')
 */
function computeDailyCalorieContext(todayRow, yesterdayRow) {
  const workouts  = todayRow?.workouts      ?? [];
  const nutrition = yesterdayRow?.nutrition ?? {};

  const rawKj  = workouts.reduce((s, w) => s + (w?.kj  ?? 0), 0);
  const rawTss = workouts.reduce((s, w) => s + (w?.tss ?? 0), 0);

  let energy_kj, kj_source;
  if (rawKj > 0) {
    energy_kj = Math.round(rawKj);
    kj_source = 'actual';
  } else if (rawTss > 0) {
    energy_kj = Math.round(rawTss * 9.5);
    kj_source = 'estimated from TSS';
  } else {
    energy_kj = DEFAULT_RIDE_KJ;
    kj_source = 'athlete default (500 kJ — no ride data)';
  }

  const estTdee   = TDEE_BASELINE + energy_kj;
  const calories  = nutrition.calories  ?? null;
  const protein_g = nutrition.protein_g ?? null;
  const deficit   = calories != null ? Math.round(estTdee - calories) : null;

  return { energy_kj, kj_source, estTdee, calories, protein_g, deficit };
}

// ── Main export ───────────────────────────────────────────────────────────

export async function buildDailyContext() {
  const today     = isoToday();
  const yesterday = addDays(today, -1);
  const start     = addDays(today, -3);

  // DB fetch (today + 3 prior days)
  const { days, windowSummary } = await exportDays(start, today);

  const todayRow     = days.find(d => d.day === today)     ?? null;
  const yesterdayRow = days.find(d => d.day === yesterday) ?? null;
  const priorDays    = days.filter(d => d.day !== today).slice(0, 3);

  // Build last-3-nights sleep summary for trend context (score + duration only)
  const last3Nights = priorDays.map(d => ({
    date:           d.day,
    score:          d.readiness?.score ?? null,
    duration_hours: d.sleep?.total_sleep_sec != null
      ? Math.round((d.sleep.total_sleep_sec / 3600) * 100) / 100
      : null,
  }));

  // Full last-night Oura data (Oura attributes sleep to the date the session
  // started, which is yesterday's calendar date)
  const lastNightOura = {
    date:      yesterdayRow?.day ?? yesterday,
    sleep:     yesterdayRow?.sleep     ?? null,
    readiness: yesterdayRow?.readiness ?? null,
  };

  const lastStravaSync = await getLastStravaSyncStatus(4);
  const calorieContext = computeDailyCalorieContext(todayRow, yesterdayRow);
  const dataGate       = buildDataGate(todayRow, yesterdayRow, lastStravaSync);

  if (dataGate.missing_sources.length > 0) {
    console.log(`[data_gate] Missing sources: ${dataGate.missing_sources.join(', ')}`);
  } else {
    console.log('[data_gate] All sources present');
  }
  if (!dataGate.strava_sync_ok) {
    const last = dataGate.strava_last_sync;
    if (last) {
      console.warn(`[data_gate] Strava sync unhealthy — last status: ${last.status} @ ${last.triggered_at} | error: ${last.error_message}`);
    } else {
      console.warn('[data_gate] Strava sync unhealthy — no sync log entry in last 4 hours');
    }
  }

  // Notion fetches (in parallel — failures are warned, not thrown)
  const [workoutPageIds, dpsPageId, powerZone] = await Promise.all([
    fetchWorkoutPageIds(today),
    fetchDpsPageId(today),
    fetchPowerZonePage(today),
  ]);

  return {
    mode:             'daily',
    date:             today,
    days,
    windowSummary,
    todayRow,
    yesterdayRow,
    last3Nights,
    lastNightOura,
    calorieContext,
    dataGate,
    notionRefs: {
      powerZone,                           // { id, name } | null
      dpsPageId,                           // string | null
      workoutPageIds,                      // string[]
    },
  };
}
