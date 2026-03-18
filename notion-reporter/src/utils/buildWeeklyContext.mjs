/**
 * buildWeeklyContext.mjs
 *
 * Assembles the full context object for a weekly report:
 *  - DB: last 14 days of health data + 90-day window summary
 *  - DB: next 7 days of planned workouts
 *  - Computed: deficit adherence over the last 7 days
 *  - Notion: PowerZone block page ID (no per-day DPS/workout IDs needed)
 */

import { Client as NotionClient } from '@notionhq/client';
import { exportDays, queryRows } from './db.mjs';

const TDEE_BASELINE        = 2800;
const WORKOUT_KCAL_PER_TSS = 4;

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate, n) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Deficit adherence (mirrors weekly_plan.py) ────────────────────────────

function computeDeficitAdherence(days14, today) {
  const last7Start = addDays(today, -6);
  const last7 = days14
    .filter(d => d.day >= last7Start)
    .sort((a, b) => a.day.localeCompare(b.day));

  const results = last7.map(row => {
    const nutrition = row.nutrition ?? {};
    const workouts  = row.workouts  ?? [];
    const calories  = nutrition.calories ?? null;
    const dayTss    = workouts.reduce((s, w) => s + (w?.tss ?? 0), 0);
    const estTdee   = TDEE_BASELINE + dayTss * WORKOUT_KCAL_PER_TSS;
    const deficit   = calories != null ? estTdee - calories : null;
    const onTarget  = deficit != null && deficit >= 400 && deficit <= 800;

    return { date: row.day, calories, dayTss, estTdee, actualDeficit: deficit, onTarget };
  });

  const validDeficits  = results.filter(r => r.actualDeficit != null).map(r => r.actualDeficit);
  const daysOnTarget   = results.filter(r => r.onTarget).length;
  const avgDeficit     = validDeficits.length
    ? Math.round(validDeficits.reduce((a, b) => a + b, 0) / validDeficits.length)
    : null;

  const missed = results
    .filter(r => !r.onTarget)
    .map(r => {
      const d = r.actualDeficit;
      let direction;
      if (d == null)      direction = 'no data';
      else if (d < 0)     direction = `surplus (${Math.abs(Math.round(d))} kcal over TDEE)`;
      else if (d < 400)   direction = 'under-deficit';
      else                direction = 'over-deficit';
      return { date: r.date, direction, deficit: d };
    });

  const missedStr = missed.length
    ? missed.map(m => `${m.date} (${m.direction})`).join(', ')
    : 'none';

  return {
    summary: {
      days_on_target:           daysOnTarget,
      total_days_with_data:     validDeficits.length,
      avg_deficit:              avgDeficit,
      missed,
    },
    formatted: `${daysOnTarget}/7 | avg deficit: ${avgDeficit ?? 'no data'} kcal | missed: ${missedStr}`,
  };
}

// ── Planned workouts (next 7 days) ────────────────────────────────────────

async function fetchPlannedNextWeek(today) {
  const nextWeekEnd = addDays(today, 7);
  const rows = await queryRows(
    `SELECT planned_date, class_type, duration_min, estimated_tss, notes
       FROM planned_workouts
      WHERE planned_date BETWEEN $1 AND $2
      ORDER BY planned_date, class_type`,
    [today, nextWeekEnd],
  );
  return rows.map(r => ({
    planned_date:  r.planned_date instanceof Date
      ? r.planned_date.toISOString().slice(0, 10)
      : String(r.planned_date).slice(0, 10),
    class_type:    r.class_type,
    duration_min:  r.duration_min,
    estimated_tss: r.estimated_tss != null ? Number(r.estimated_tss) : null,
    notes:         r.notes,
  }));
}

// ── Notion helper ─────────────────────────────────────────────────────────

function extractPageTitle(page) {
  const titleProp = Object.values(page.properties ?? {}).find(p => p.type === 'title');
  return titleProp?.title?.[0]?.plain_text ?? 'Unknown Block';
}

async function fetchPowerZonePage(targetDate) {
  const dbId = process.env.NOTION_POWERZONE_DB_ID;
  if (!dbId) {
    console.warn('[warn] NOTION_POWERZONE_DB_ID not set — skipping PowerZone block fetch');
    return null;
  }

  const dateProp = process.env.NOTION_POWERZONE_DATE_PROP || 'Date';
  const notion   = new NotionClient({ auth: process.env.NOTION_TOKEN });

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
    // Date filter may have failed — fall through to fallback
  }

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

// ── Main export ───────────────────────────────────────────────────────────

export async function buildWeeklyContext() {
  const today = isoToday();

  // Run DB fetches in parallel
  const [
    data14,
    data90,
    plannedNextWeek,
    powerZone,
  ] = await Promise.all([
    exportDays(addDays(today, -13), today),
    exportDays(addDays(today, -89), today),
    fetchPlannedNextWeek(today),
    fetchPowerZonePage(today),
  ]);

  const { days: days14 }                     = data14;
  const { windowSummary: quarterSummary }    = data90;

  const { summary: adherenceSummary, formatted: deficitAdherenceStr } =
    computeDeficitAdherence(days14, today);

  return {
    mode:                'weekly',
    date:                today,
    days:                days14,
    windowSummary:       quarterSummary,
    deficitAdherence:    adherenceSummary,
    deficitAdherenceStr,
    plannedNextWeek,
    notionRefs: {
      powerZone,           // { id, name } | null
      dpsPageId:    null,  // not used for weekly reports
      workoutPageIds: [],  // not used for weekly reports
    },
  };
}
