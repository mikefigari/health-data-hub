/**
 * buildWeeklyContext.mjs
 *
 * Assembles the full context object for a weekly report:
 *  - DB: last 14 days of health data + 90-day window summary
 *  - DB: next 7 days of planned workouts
 *  - Computed: prior Mon-Sun (LA) nutrition week + weight trend (nutritionWeek.mjs)
 *  - Notion: PowerZone block page ID (no per-day DPS/workout IDs needed)
 */

import { Client as NotionClient } from '@notionhq/client';
import { exportDays, queryRows, getNutritionWeekInputs } from './db.mjs';
import {
  laToday, priorWeekBounds, weeklyDeficit, weightTrend, calibratedMaintenance,
} from './nutritionWeek.mjs';

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

/**
 * Pure assembly. rows: exportDays-style rows (may span >7 days, incl. 28-day lookback).
 * opts: { today, weighIns, goals, windowSummary, plannedNextWeek, notionRefs }
 */
export function buildWeeklyContextFrom(rows, opts = {}) {
  const { today, weighIns = [], goals = null, windowSummary = null, plannedNextWeek = [], notionRefs } = opts;
  const { start: weekStart, end: weekEnd } = priorWeekBounds(today);
  const weekRows = (rows ?? []).filter(r => r.day >= weekStart && r.day <= weekEnd);

  const cal = calibratedMaintenance(rows, weighIns, { asOf: weekEnd });
  const calibrated = cal.method === 'scale_calibrated' && cal.maintenance_est != null;
  const nutritionWeek = {
    ...weeklyDeficit(weekRows, calibrated ? { maintenance: cal.maintenance_est } : {}),
    maintenance_method: calibrated ? 'scale_calibrated' : 'goal_calories',
  };
  if (calibrated) nutritionWeek.maintenance_est = Math.round(cal.maintenance_est);

  const targetKg = goals?.target_weight_kg != null ? Number(goals.target_weight_kg) : null;
  const weightTrendOut = weightTrend(weighIns, { asOf: weekEnd, targetKg });

  const days = (rows ?? [])
    .filter(r => r.day >= addDays(weekEnd, -13) && r.day <= weekEnd)
    .sort((a, b) => b.day.localeCompare(a.day));

  return {
    mode: 'weekly',
    date: today,
    weekStart,
    weekEnd,
    days,
    windowSummary,
    nutritionWeek,
    weightTrend: weightTrendOut,
    targetWeightKg: targetKg,
    plannedNextWeek,
    notionRefs: notionRefs ?? { powerZone: null, dpsPageId: null, workoutPageIds: [] },
  };
}

export async function buildWeeklyContext() {
  const today = laToday();
  const { start: weekStart, end: weekEnd } = priorWeekBounds(today);

  const [data28, data90, inputs, plannedNextWeek, powerZone] = await Promise.all([
    exportDays(addDays(weekEnd, -27), weekEnd),
    exportDays(addDays(weekEnd, -89), weekEnd),
    getNutritionWeekInputs(weekStart, weekEnd),
    fetchPlannedNextWeek(today),
    fetchPowerZonePage(today),
  ]);

  return buildWeeklyContextFrom(data28.days, {
    today,
    weighIns: inputs.weighIns,
    goals: inputs.goals,
    windowSummary: data90.windowSummary,
    plannedNextWeek,
    notionRefs: {
      powerZone,           // { id, name } | null
      dpsPageId: null,     // not used for weekly reports
      workoutPageIds: [],  // not used for weekly reports
    },
  });
}
