// Read-only SQL inputs for buildDashboard. Columns are named explicitly: never
// SELECT *, and never meals_json, notes, title, food item names or *_raw tables.
const LA_TODAY_SQL = `SELECT ((now() AT TIME ZONE 'America/Los_Angeles')::date)::text AS today`;

const WEIGHTS_SQL = `SELECT day::text AS day, weight_kg FROM public.body_weight_daily ORDER BY day`;

const GOALS_SQL = `SELECT effective_from::text AS effective_from, target_weight_kg, base_calories,
       cycling_kj_factor, protein_g
  FROM public.nutrition_goals ORDER BY effective_from`;

const FTP_SQL = `SELECT effective_from::text AS day, ftp_watts AS ftp_w
  FROM public.ftp_history ORDER BY effective_from`;

// $1 = today (LA date). History window covers the longest range (365) plus slack.
const NUTRITION_SQL = `SELECT day::text AS day, calories, protein_g, carbs_g, fat_g,
       goal_calories, goal_protein_g, logged_complete
  FROM public.nutrition_daily
 WHERE day >= $1::date - 400 AND day <= $1::date
 ORDER BY day`;

// Strava start_time is naive UTC: convert to the LA calendar day, as in
// 2026-11_02_nutrition_daily_view.sql (rides CTE).
const RIDES_SQL = `SELECT (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date::text AS day,
       sum(kj) AS kj
  FROM public.workout_summary
 WHERE sport_type = 'Ride' AND device_watts AND kj > 0
   AND start_time >= ($1::date - 402)::timestamp
 GROUP BY 1
 ORDER BY 1`;

const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export async function fetchInputs(pool) {
  const t = await pool.query(LA_TODAY_SQL);
  const today = dayOf(t.rows[0].today);
  const [weights, goals, ftp, nutrition, rides] = await Promise.all([
    pool.query(WEIGHTS_SQL),
    pool.query(GOALS_SQL),
    pool.query(FTP_SQL),
    pool.query(NUTRITION_SQL, [today]),
    pool.query(RIDES_SQL, [today]),
  ]);
  return {
    today,
    weights: weights.rows.map((r) => ({ day: dayOf(r.day), kg: r.weight_kg })),
    goals: goals.rows,
    ftp: ftp.rows.map((r) => ({ day: dayOf(r.day), ftp_w: r.ftp_w })),
    nutrition: nutrition.rows,
    rideKj: rides.rows.map((r) => ({ day: dayOf(r.day), kj: r.kj })),
  };
}

// Resolves when the pool's sessions default to read-only; rejects otherwise.
export async function checkReadOnly(pool) {
  const { rows } = await pool.query(`SELECT current_setting('default_transaction_read_only') AS ro`);
  if (rows[0]?.ro !== 'on') {
    throw new Error('database session is not read-only (default_transaction_read_only is off)');
  }
}
