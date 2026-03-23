/**
 * buildDailyContext.mjs
 *
 * Assembles the full context object for a daily report:
 *  - DB: today + 3 prior days of health data
 *  - Notion: workout page IDs, DPS page ID, PowerZone block page ID
 */

import { Client as NotionClient } from '@notionhq/client';
import { exportDays } from './db.mjs';

const TDEE_BASELINE        = 2800;

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

// ── Deficit context for the daily prompt ──────────────────────────────────

function computeDailyCalorieContext(todayRow) {
  const workouts  = todayRow?.workouts ?? [];
  const nutrition = todayRow?.nutrition ?? {};
  const dayTss    = workouts.reduce((s, w) => s + (w?.tss ?? 0), 0);
  const dayKj     = workouts.reduce((s, w) => s + (w?.kj  ?? 0), 0);
  const estTdee   = TDEE_BASELINE + Math.round(dayKj);
  const calories  = nutrition.calories ?? null;
  const deficit   = calories != null ? estTdee - calories : null;
  return { dayTss, dayKj, estTdee, calories, deficit };
}

// ── Main export ───────────────────────────────────────────────────────────

export async function buildDailyContext() {
  const today = isoToday();
  const start = addDays(today, -3);

  // DB fetch (today + 3 prior days)
  const { days, windowSummary } = await exportDays(start, today);

  const todayRow  = days.find(d => d.day === today) ?? days[0] ?? null;
  const priorDays = days.filter(d => d.day !== today).slice(0, 3);

  // Build last-3-nights sleep summary for the prompt
  const last3Nights = priorDays.map(d => ({
    date:           d.day,
    score:          d.readiness?.score ?? null,
    duration_hours: d.sleep?.total_sleep_sec != null
      ? Math.round((d.sleep.total_sleep_sec / 3600) * 100) / 100
      : null,
  }));

  const calorieContext = computeDailyCalorieContext(todayRow);

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
    last3Nights,
    calorieContext,
    notionRefs: {
      powerZone,                           // { id, name } | null
      dpsPageId,                           // string | null
      workoutPageIds,                      // string[]
    },
  };
}
