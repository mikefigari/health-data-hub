/**
 * Lightweight PostgreSQL pool wrapper.
 * Reads connection settings from environment variables.
 */

import pg from 'pg';
const { Pool } = pg;

let _pool;

function getPool() {
  if (!_pool) {
    _pool = new Pool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME     || 'health',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD,
    });
  }
  return _pool;
}

export async function queryRows(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows;
}

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}

// ── Daily export SQL (mirrors health_data_hub/etl/export_daily_json.py) ──────
// $1 = start_date (ISO string), $2 = end_date (ISO string)
export const EXPORT_SQL = `
WITH RECURSIVE date_series AS (
    SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
),
sleep AS (
    SELECT
        day, efficiency, total_sleep_sec, rem_sleep_sec, deep_sleep_sec,
        light_sleep_sec, awake_sec, latency_sec, restless_periods,
        lowest_hr, avg_hr AS sleep_avg_hr, avg_hrv AS sleep_avg_hrv,
        avg_breath, sleep_id
    FROM oura_sleep_raw
    WHERE day BETWEEN $1 AND $2
      AND raw_json->>'type' = 'long_sleep'
),
readiness AS (
    SELECT
        day, score AS readiness_score, temp_dev, temp_trend_dev,
        r_hrv_balance, r_recovery_index, r_resting_hr, r_sleep_balance,
        r_activity_balance, r_prev_night
    FROM oura_readiness_raw
    WHERE day BETWEEN $1 AND $2
),
activity AS (
    SELECT
        day, steps, cal_total, cal_active, inactive_sec, low_activity_sec,
        medium_activity_sec, high_activity_sec, met_min_low, met_min_medium, met_min_high
    FROM oura_activity_raw
    WHERE day BETWEEN $1 AND $2
),
hr_agg AS (
    SELECT
        s.sleep_id,
        ROUND(AVG(h.bpm)::numeric, 1)       AS avg_overnight_bpm,
        ROUND(MIN(h.bpm)::numeric, 1)       AS min_overnight_bpm,
        ROUND(AVG(h.hrv_rmssd)::numeric, 1) AS avg_hrv_rmssd
    FROM oura_hr_samples h
    JOIN sleep s ON h.sleep_id = s.sleep_id
    GROUP BY s.sleep_id
),
workouts AS (
    SELECT
        (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date AS day,
        json_agg(json_build_object(
            'workout_id',       workout_id,
            'title',            title,
            'sport_type',       sport_type,
            'start_time',       start_time,
            'duration_s',       moving_s,
            'distance_m',       distance_m,
            'avg_hr',           avg_hr,
            'max_hr',           max_hr,
            'avg_watts',        avg_watts,
            'np_watts',         np_watts,
            'intensity_factor', intensity_factor,
            'tss',              tss_power,
            'kj',               kj,
            'elevation_m',      total_elevation_gain
        ) ORDER BY start_time) AS workouts
    FROM workout_summary
    WHERE (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date BETWEEN $1 AND $2
    GROUP BY (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date
),
phys AS (
    SELECT day, overall_state, energy_level, body_signals, notes AS subjective_notes, entry_confidence
    FROM daily_physical_state
    WHERE day BETWEEN $1 AND $2
),
nutrition AS (
    SELECT
        day, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
        goal_calories, logged_complete, weight_kg
    FROM nutrition_daily
    WHERE day BETWEEN $1 AND $2
),
body AS (
    SELECT day, weight_kg
    FROM body_weight_daily
    WHERE day BETWEEN $1 AND $2
),
planned AS (
    SELECT
        planned_date AS day,
        json_agg(json_build_object(
            'class_type',    pw.class_type,
            'duration_min',  pw.duration_min,
            'estimated_tss', pw.estimated_tss,
            'notes',         pw.notes
        ) ORDER BY pw.id) AS planned_workouts
    FROM planned_workouts pw
    WHERE planned_date BETWEEN $1 AND $2
    GROUP BY planned_date
),
daily_tss_lookback AS (
    SELECT
        gs.day,
        COALESCE(SUM(ws.tss_power), 0.0) AS daily_tss
    FROM generate_series(
        $1::date - interval '42 days',
        $2::date,
        interval '1 day'
    ) AS gs(day)
    LEFT JOIN workout_summary ws ON (ws.start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date = gs.day
    GROUP BY gs.day
),
ema_calc AS (
    SELECT day, daily_tss, daily_tss AS ctl, daily_tss AS atl
    FROM daily_tss_lookback
    WHERE day = $1::date - interval '42 days'

    UNION ALL

    SELECT
        tl.day, tl.daily_tss,
        ec.ctl + (tl.daily_tss - ec.ctl) / 42.0 AS ctl,
        ec.atl + (tl.daily_tss - ec.atl) / 7.0  AS atl
    FROM ema_calc ec
    JOIN daily_tss_lookback tl ON tl.day = ec.day + interval '1 day'
),
pmc AS (
    SELECT
        day,
        ROUND(ctl::numeric, 1)         AS ctl,
        ROUND(atl::numeric, 1)         AS atl,
        ROUND((ctl - atl)::numeric, 1) AS tsb
    FROM ema_calc
    WHERE day BETWEEN $1 AND $2
)
SELECT
    d.day,
    json_build_object(
        'efficiency',       sl.efficiency,
        'total_sleep_sec',  sl.total_sleep_sec,
        'rem_sec',          sl.rem_sleep_sec,
        'deep_sec',         sl.deep_sleep_sec,
        'light_sec',        sl.light_sleep_sec,
        'awake_sec',        sl.awake_sec,
        'latency_sec',      sl.latency_sec,
        'restless_periods', sl.restless_periods,
        'lowest_hr',        sl.lowest_hr,
        'avg_hr',           sl.sleep_avg_hr,
        'avg_hrv',          sl.sleep_avg_hrv,
        'avg_breath',       sl.avg_breath
    ) AS sleep,
    json_build_object(
        'score',             re.readiness_score,
        'temp_dev',          re.temp_dev,
        'r_hrv_balance',     re.r_hrv_balance,
        'r_recovery_index',  re.r_recovery_index,
        'r_resting_hr',      re.r_resting_hr,
        'r_sleep_balance',   re.r_sleep_balance,
        'r_activity_balance',re.r_activity_balance,
        'r_prev_night',      re.r_prev_night
    ) AS readiness,
    json_build_object(
        'steps',               ac.steps,
        'cal_total',           ac.cal_total,
        'cal_active',          ac.cal_active,
        'inactive_sec',        ac.inactive_sec,
        'low_activity_sec',    ac.low_activity_sec,
        'medium_activity_sec', ac.medium_activity_sec,
        'high_activity_sec',   ac.high_activity_sec,
        'met_min_low',         ac.met_min_low,
        'met_min_medium',      ac.met_min_medium,
        'met_min_high',        ac.met_min_high
    ) AS activity,
    json_build_object(
        'avg_overnight_bpm', hr.avg_overnight_bpm,
        'min_overnight_bpm', hr.min_overnight_bpm,
        'avg_hrv_rmssd',     hr.avg_hrv_rmssd
    ) AS hr_overnight,
    COALESCE(wo.workouts, '[]'::json)          AS workouts,
    json_build_object(
        'overall_state',    ph.overall_state,
        'energy_level',     ph.energy_level,
        'body_signals',     ph.body_signals,
        'notes',            ph.subjective_notes,
        'entry_confidence', ph.entry_confidence
    ) AS physical_state,
    json_build_object(
        'calories',        nu.calories,
        'protein_g',       nu.protein_g,
        'carbs_g',         nu.carbs_g,
        'fat_g',           nu.fat_g,
        'fiber_g',         nu.fiber_g,
        'sugar_g',         nu.sugar_g,
        'sodium_mg',       nu.sodium_mg,
        'goal_calories',   nu.goal_calories,
        'logged_complete', nu.logged_complete,
        'weight_kg',       COALESCE(bw.weight_kg, nu.weight_kg)
    ) AS nutrition,
    json_build_object('ctl', pm.ctl, 'atl', pm.atl, 'tsb', pm.tsb) AS performance_management,
    COALESCE(pl.planned_workouts, '[]'::json)  AS planned_workouts
FROM date_series d
LEFT JOIN sleep       sl ON sl.day      = d.day
LEFT JOIN readiness   re ON re.day      = d.day
LEFT JOIN activity    ac ON ac.day      = d.day
LEFT JOIN hr_agg      hr ON hr.sleep_id = sl.sleep_id
LEFT JOIN workouts    wo ON wo.day      = d.day
LEFT JOIN phys        ph ON ph.day      = d.day
LEFT JOIN nutrition   nu ON nu.day      = d.day
LEFT JOIN body        bw ON bw.day      = d.day
LEFT JOIN pmc         pm ON pm.day      = d.day
LEFT JOIN planned     pl ON pl.day      = d.day
ORDER BY d.day DESC;
`;

/**
 * Inputs for the weekly nutrition review: nutrition_daily rows for
 * startDay..endDay, weigh-ins for the trailing 28 days through endDay, and the
 * current nutrition_goals row. Days are 'YYYY-MM-DD' (LA dates).
 */
export async function getNutritionWeekInputs(startDay, endDay) {
  const nutrition = await queryRows(
    `SELECT day::text AS day, calories, goal_calories, logged_complete
     FROM nutrition_daily
     WHERE day BETWEEN $1::date AND $2::date
     ORDER BY day ASC`,
    [startDay, endDay],
  );
  const weighIns = await queryRows(
    `SELECT day::text AS day, weight_kg
     FROM body_weight_daily
     WHERE day BETWEEN ($1::date - 28) AND $1::date
     ORDER BY day ASC`,
    [endDay],
  );
  const goalRows = await queryRows(
    `SELECT * FROM nutrition_goals
     WHERE effective_from <= $1::date
     ORDER BY effective_from DESC
     LIMIT 1`,
    [endDay],
  );
  const rideKcalByDay = await getRideKcalByDay(startDay, endDay);
  return { nutrition, weighIns, goals: goalRows[0] ?? null, rideKcalByDay };
}

/**
 * Ride energy in kcal per LA day, as {day: kcal}. Same rule as nutrition_daily:
 * powered Rides only, UTC start converted to LA, kJ times the cycling factor of
 * the goal in effect that day.
 */
export async function getRideKcalByDay(startDay, endDay) {
  const rows = await queryRows(
    `WITH rides AS (
         SELECT (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date AS day,
                sum(kj) AS kj
           FROM workout_summary
          WHERE sport_type = 'Ride' AND device_watts AND kj > 0
          GROUP BY 1
     )
     SELECT r.day::text AS day,
            round(coalesce(g.cycling_kj_factor, 1) * r.kj::numeric)::int AS ride_kcal
       FROM rides r
       LEFT JOIN LATERAL (
           SELECT cycling_kj_factor FROM nutrition_goals g0
            WHERE g0.effective_from <= r.day
            ORDER BY g0.effective_from DESC
            LIMIT 1
       ) g ON true
      WHERE r.day BETWEEN $1::date AND $2::date`,
    [startDay, endDay],
  );
  return Object.fromEntries(rows.map(r => [r.day, Number(r.ride_kcal)]));
}

/**
 * Return the most recently recorded body weight: the latest day in
 * body_weight_daily (Renpho scale via Apple Health), falling back to
 * nutrition_daily.weight_kg. Returns null if no weight has ever been logged.
 */
export async function getLastRecordedWeight() {
  try {
    const bodyRows = await queryRows(
      `SELECT weight_kg FROM body_weight_daily
       ORDER BY day DESC
       LIMIT 1`,
    );
    if (bodyRows[0]?.weight_kg != null) return parseFloat(bodyRows[0].weight_kg);

    const rows = await queryRows(
      `SELECT weight_kg FROM nutrition_daily
       WHERE weight_kg IS NOT NULL
       ORDER BY day DESC
       LIMIT 1`,
    );
    return rows[0]?.weight_kg != null ? parseFloat(rows[0].weight_kg) : null;
  } catch {
    return null;
  }
}

/**
 * Return the 30-day rolling average HRV (avg_hrv from long_sleep sessions).
 * Used as a personal baseline for classifying today's HRV as low/normal/high.
 * Returns null if insufficient data.
 */
export async function getHrvBaseline(days = 30) {
  try {
    const rows = await queryRows(
      `SELECT AVG(avg_hrv)::numeric(5,1) AS baseline
       FROM oura_sleep_raw
       WHERE day >= CURRENT_DATE - ($1 || ' days')::interval
         AND avg_hrv IS NOT NULL
         AND raw_json->>'type' = 'long_sleep'`,
      [days],
    );
    const val = rows[0]?.baseline;
    return val != null ? parseFloat(val) : null;
  } catch {
    return null;
  }
}

/**
 * Return the most recent strava_sync_log entry within the last `windowHours` hours.
 * Returns null if the table doesn't exist or no rows are found.
 */
export async function getLastStravaSyncStatus(windowHours = 4) {
  try {
    const rows = await queryRows(
      `SELECT status, triggered_at, activities_written, error_message
       FROM strava_sync_log
       WHERE triggered_at >= NOW() - ($1 || ' hours')::interval
       ORDER BY triggered_at DESC
       LIMIT 1`,
      [windowHours],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Run EXPORT_SQL for the given date range.
 * Returns { days, windowSummary } mirroring export_daily_json() in Python.
 */
export async function exportDays(startDate, endDate) {
  const rows = await queryRows(EXPORT_SQL, [startDate, endDate]);

  const days = rows.map(r => ({
    day:                   r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
    sleep:                 r.sleep,
    readiness:             r.readiness,
    activity:              r.activity,
    hr_overnight:          r.hr_overnight,
    workouts:              r.workouts,
    physical_state:        r.physical_state,
    nutrition:             r.nutrition,
    performance_management:r.performance_management,
    planned_workouts:      r.planned_workouts,
  }));

  const pmcRows = days.filter(d => d.performance_management?.ctl != null);
  let windowSummary = null;
  if (pmcRows.length) {
    // rows are ORDER BY day DESC → pmcRows[0] = most recent, last = oldest
    const current = pmcRows[0].performance_management;
    const oldest  = pmcRows[pmcRows.length - 1].performance_management;
    windowSummary = {
      ctl_start:   oldest.ctl,
      ctl_end:     current.ctl,
      ctl_change:  Math.round((current.ctl - oldest.ctl) * 10) / 10,
      tsb_min:     Math.min(...pmcRows.map(d => d.performance_management.tsb)),
      tsb_max:     Math.max(...pmcRows.map(d => d.performance_management.tsb)),
      tsb_current: current.tsb,
    };
  }

  return { days, windowSummary };
}
