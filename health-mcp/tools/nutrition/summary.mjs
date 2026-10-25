import { z } from 'zod';
import { ToolError, validationError, errorResult, jsonResult, num, round1, round2, laDayString } from './common.mjs';

export const GET_DAY_SUMMARY_DESCRIPTION =
  "Show what's logged for a day (default: today in Los Angeles): totals, goal, remaining calories, per-meal breakdown, " +
  'cycling calories earned, latest weight and kg_to_target, and every item with its id, confidence and source. ' +
  'Use the item ids with update_log_entry and delete_log_entry.';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDay(day) {
  const m = DAY_RE.exec(day);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return day;
  }
  throw validationError('day must be a valid YYYY-MM-DD date', 'day');
}

const ITEMS_SQL = `
  SELECT id, to_char(eaten_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD"T"HH24:MI:SS') AS eaten_at_local,
         meal, description, quantity, unit, grams, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g,
         sodium_mg, confidence, match_source, my_food_id, fdc_id, ref_label, notes
    FROM food_log WHERE day = $1::date AND deleted_at IS NULL ORDER BY eaten_at, id`;

const DAILY_SQL = `
  SELECT calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, goal_calories, goal_protein_g,
         goal_carbs_g, goal_fat_g, source, logged_complete
    FROM nutrition_daily WHERE day = $1::date`;

const GOAL_SQL = `
  SELECT target_weight_kg, cycling_kj_factor FROM nutrition_goals
   WHERE effective_from <= $1::date ORDER BY effective_from DESC LIMIT 1`;

// D5: powered Rides only; the ride day is start_time::date.
const CYCLING_SQL = `
  SELECT round($2::numeric * coalesce(sum(kj), 0))::int AS kcal
    FROM workout_summary
   WHERE sport_type = 'Ride' AND device_watts AND kj > 0 AND start_time::date = $1::date`;

const WEIGHT_SQL = `SELECT day::text AS day, weight_kg FROM body_weight_daily ORDER BY day DESC LIMIT 1`;

const SHARE_SQL = `SELECT estimated_calorie_share, items_missing_micros FROM food_log_daily WHERE day = $1::date`;

function mapItem(r) {
  return {
    id: Number(r.id),
    eaten_at_local: r.eaten_at_local,
    meal: r.meal,
    description: r.description,
    quantity: num(r.quantity),
    unit: r.unit,
    grams: num(r.grams),
    calories: num(r.calories),
    protein_g: num(r.protein_g),
    carbs_g: num(r.carbs_g),
    fat_g: num(r.fat_g),
    fiber_g: num(r.fiber_g),
    sugar_g: num(r.sugar_g),
    sodium_mg: num(r.sodium_mg),
    confidence: r.confidence,
    match_source: r.match_source,
    my_food_id: r.my_food_id === null ? null : Number(r.my_food_id),
    fdc_id: r.fdc_id,
    ref_label: r.ref_label,
    notes: r.notes,
  };
}

function byMeal(items) {
  const out = {};
  for (const it of items) {
    const m = (out[it.meal] ??= { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, items: 0 });
    m.calories = round1(m.calories + it.calories);
    m.protein_g = round1(m.protein_g + it.protein_g);
    m.carbs_g = round1(m.carbs_g + it.carbs_g);
    m.fat_g = round1(m.fat_g + it.fat_g);
    m.items += 1;
  }
  return out;
}

export async function buildDaySummary(pool, day, includeItems) {
  const daily = (await pool.query(DAILY_SQL, [day])).rows[0];
  const goal = (await pool.query(GOAL_SQL, [day])).rows[0];
  const factor = goal ? Number(goal.cycling_kj_factor) : 1;
  const cycling_kcal = Number((await pool.query(CYCLING_SQL, [day, factor])).rows[0].kcal);
  const w = (await pool.query(WEIGHT_SQL)).rows[0];
  const target = goal && goal.target_weight_kg !== null ? Number(goal.target_weight_kg) : null;
  const weight_kg = w ? num(w.weight_kg) : null;

  const out = {
    day,
    source: daily ? (daily.source === 'food_log' ? 'food_log' : 'legacy') : 'none',
    cycling_kcal,
    latest_weight_kg: weight_kg,
    latest_weight_day: w ? w.day : null,
    target_weight_kg: target,
    kg_to_target: weight_kg !== null && target !== null ? round2(weight_kg - target) : null,
  };

  if (!daily) {
    return { ...out, totals: null, goals: null, remaining: null, by_meal: {}, items: [], logged_complete: null };
  }

  out.totals = {
    calories: num(daily.calories),
    protein_g: num(daily.protein_g),
    carbs_g: num(daily.carbs_g),
    fat_g: num(daily.fat_g),
    fiber_g: num(daily.fiber_g),
    sugar_g: num(daily.sugar_g),
    sodium_mg: num(daily.sodium_mg),
  };
  out.goals = {
    calories: num(daily.goal_calories),
    protein_g: num(daily.goal_protein_g),
    carbs_g: num(daily.goal_carbs_g),
    fat_g: num(daily.goal_fat_g),
  };
  const rem = (g, t) => (g === null || t === null ? null : round1(g - t));
  out.remaining = {
    calories: rem(out.goals.calories, out.totals.calories),
    protein_g: rem(out.goals.protein_g, out.totals.protein_g),
    carbs_g: rem(out.goals.carbs_g, out.totals.carbs_g),
    fat_g: rem(out.goals.fat_g, out.totals.fat_g),
  };
  out.logged_complete = daily.logged_complete;

  if (daily.source === 'food_log') {
    const items = (await pool.query(ITEMS_SQL, [day])).rows.map(mapItem);
    const share = (await pool.query(SHARE_SQL, [day])).rows[0];
    out.by_meal = byMeal(items);
    out.items = includeItems ? items : [];
    out.estimated_calorie_share = share ? num(share.estimated_calorie_share) : null;
    out.items_missing_micros = share ? Number(share.items_missing_micros) : 0;
  } else {
    out.by_meal = {};
    out.items = [];
    out.note = 'historical import, no item detail';
  }
  return out;
}

export function registerGetDaySummary(server, { pool, now }) {
  server.registerTool(
    'get_day_summary',
    {
      title: 'Day summary',
      description: GET_DAY_SUMMARY_DESCRIPTION,
      inputSchema: {
        day: z.string().optional().describe('YYYY-MM-DD; default today in Los Angeles'),
        include_items: z.boolean().optional().describe('default true'),
      },
    },
    async ({ day, include_items = true }) => {
      try {
        const d = day === undefined ? laDayString(now()) : parseDay(day);
        return jsonResult(await buildDaySummary(pool, d, include_items));
      } catch (err) {
        if (err instanceof ToolError) return errorResult(err.code, err.message, { field: err.field });
        console.error('get_day_summary failed:', err && err.message);
        return errorResult('DB_ERROR', 'Database error while reading the day summary.');
      }
    }
  );
}
