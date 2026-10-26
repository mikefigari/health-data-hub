// Pure weekly nutrition + weight math. No I/O.
// Row shape (as buildWeeklyContext): { day:'YYYY-MM-DD', nutrition:{ calories, goal_calories, logged_complete } }
// Weigh-ins: [{ day, weight_kg }].

const KCAL_PER_KG = 7700;
const TREND_WINDOW_DAYS = 28;

export const lossRateKgPerWeek = () => {
  const v = parseFloat(process.env.WEEKLY_LOSS_TARGET_KG);
  return Number.isFinite(v) && v > 0 ? v : 0.75;
};
export const weeklyTargetKcal = () => Math.round(lossRateKgPerWeek() * KCAL_PER_KG);

const addDays = (d, n) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const dayNum = (d) => Date.parse(d + 'T00:00:00Z') / 864e5;
const mondayOf = (d) => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));

export function laToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function priorWeekBounds(today) {
  const start = addDays(mondayOf(today), -7);
  return { start, end: addDays(start, 6) };
}

export function currentWeekMonWed(today) {
  const start = mondayOf(today);
  return { start, end: addDays(start, 2) };
}

const num = (v) => (v == null ? null : Number(v));

// Usable = food logged, not marked incomplete, and a maintenance figure is available.
function usableDeficits(days, maintenance) {
  const out = [];
  for (const r of days ?? []) {
    const n = r?.nutrition;
    if (!n) continue;
    const cal = num(n.calories);
    if (!(cal > 0) || n.logged_complete === false) continue;
    const maint = maintenance != null ? maintenance : num(n.goal_calories);
    if (maint == null) continue;
    out.push(maint - cal);
  }
  return out;
}

export function weeklyDeficit(days, { maintenance = null } = {}) {
  const target_total = weeklyTargetKcal();
  const target_daily = target_total / 7;
  const rows = (days ?? []).filter(r => r?.nutrition);
  const logged = rows.filter(r => num(r.nutrition.calories) > 0);
  const n_logged = logged.length;
  const n_marked_complete = logged.filter(r => r.nutrition.logged_complete === true).length;
  const defs = usableDeficits(days, maintenance);
  const n_usable = defs.length;
  if (n_usable === 0) {
    return {
      status: 'no_data', on_track: false, avg_deficit: null, projected_week_total: null,
      projected_kg_per_week: null, target_total, target_daily: Math.round(target_daily),
      n_usable, n_logged, n_marked_complete,
    };
  }
  const avg = defs.reduce((a, b) => a + b, 0) / n_usable;
  return {
    status: avg > 0 ? 'deficit' : 'surplus',
    on_track: avg >= target_daily,
    avg_deficit: Math.round(avg),
    projected_week_total: Math.round(avg * 7),
    projected_kg_per_week: Math.round((avg * 7 / KCAL_PER_KG) * 100) / 100,
    target_total, target_daily: Math.round(target_daily),
    n_usable, n_logged, n_marked_complete,
  };
}

// Least-squares slope (kg/day) over points {x: dayNumber, y: kg}.
function slopePerDay(pts) {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0, sxx = 0;
  for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
  return sxx === 0 ? null : sxy / sxx;
}

function windowWeighIns(weighIns, asOf) {
  const lo = dayNum(asOf) - (TREND_WINDOW_DAYS - 1), hi = dayNum(asOf);
  return (weighIns ?? [])
    .filter(w => w?.weight_kg != null && dayNum(w.day) >= lo && dayNum(w.day) <= hi)
    .map(w => ({ day: w.day, x: dayNum(w.day), y: Number(w.weight_kg) }))
    .sort((a, b) => a.x - b.x);
}

export function weightTrend(weighIns, { asOf, targetKg } = {}) {
  const upto = (weighIns ?? []).filter(w => w?.weight_kg != null && dayNum(w.day) <= dayNum(asOf))
    .sort((a, b) => dayNum(a.day) - dayNum(b.day));
  const last = upto[upto.length - 1] ?? null;
  const base = {
    latest_kg: last ? Number(last.weight_kg) : null,
    latest_day: last ? last.day : null,
    days_since_weigh_in: last ? Math.round(dayNum(asOf) - dayNum(last.day)) : null,
    kg_to_target: last && targetKg != null ? Math.round((Number(last.weight_kg) - targetKg) * 1000) / 1000 : null,
    trend_kg_per_week: null, target_date_at_rate: null, target_date_at_trend: null,
  };
  const pts = windowWeighIns(weighIns, asOf);
  if (pts.length < 2 || pts[pts.length - 1].x - pts[0].x < 7) {
    return { ...base, reason: 'insufficient_weigh_ins' };
  }
  const s = slopePerDay(pts);
  if (s == null) return { ...base, reason: 'insufficient_weigh_ins' };
  const perWeek = s * 7;
  const out = { ...base, trend_kg_per_week: Math.round(perWeek * 100) / 100, reason: null };
  out.trend_kg_per_week_raw = perWeek;
  if (base.kg_to_target != null && base.kg_to_target > 0) {
    out.target_date_at_rate = addDays(asOf, Math.round(base.kg_to_target / lossRateKgPerWeek() * 7));
    if (perWeek < 0) out.target_date_at_trend = addDays(asOf, Math.round(base.kg_to_target / -perWeek * 7));
  }
  return out;
}

export function calibratedMaintenance(days, weighIns, { asOf } = {}) {
  const lo = dayNum(asOf) - (TREND_WINDOW_DAYS - 1), hi = dayNum(asOf);
  const inWin = (days ?? []).filter(r => r?.day && dayNum(r.day) >= lo && dayNum(r.day) <= hi);
  const intakes = [];
  for (const r of inWin) {
    const n = r.nutrition;
    if (!n) continue;
    const cal = num(n.calories);
    if (!(cal > 0) || n.logged_complete === false || num(n.goal_calories) == null) continue;
    intakes.push(cal);
  }
  const pts = windowWeighIns(weighIns, asOf);
  const span = pts.length ? pts[pts.length - 1].x - pts[0].x : 0;
  const info = { n_usable: intakes.length, n_weigh_ins: pts.length, method: 'goal_calories', maintenance_est: null };
  if (intakes.length < 21 || pts.length < 4 || span < 21) return info;
  const s = slopePerDay(pts);
  if (s == null) return info;
  const avgIntake = intakes.reduce((a, b) => a + b, 0) / intakes.length;
  return {
    ...info, method: 'scale_calibrated',
    avg_intake: Math.round(avgIntake),
    maintenance_est: avgIntake + (-s * KCAL_PER_KG),
  };
}

// Thursday check-in over the Mon-Wed rows of the current week.
export function thursdayCheck(days, opts = {}) {
  const target_total = weeklyTargetKcal();
  const pace = Math.round(target_total * 3 / 7);
  const w = weeklyDeficit(days, opts);
  if (w.status === 'no_data') {
    return {
      status: 'no_data', on_track: false, post: true, pace, target_total,
      n_usable: 0, n_logged: w.n_logged, n_marked_complete: w.n_marked_complete,
      avg_deficit: null, actual_3day: null, shortfall: null, needed_per_day_thu_sun: null,
    };
  }
  const defs = usableDeficits(days, opts.maintenance ?? null);
  const avg = defs.reduce((a, b) => a + b, 0) / defs.length;
  const actual = avg * 3;
  const on_track = avg >= target_total / 7;
  return {
    status: w.status, on_track, post: !on_track, pace, target_total,
    n_usable: w.n_usable, n_logged: w.n_logged, n_marked_complete: w.n_marked_complete,
    avg_deficit: w.avg_deficit,
    actual_3day: Math.round(actual),
    shortfall: Math.max(0, Math.round(pace - actual)),
    needed_per_day_thu_sun: Math.max(0, Math.ceil((target_total - actual) / 4 - 1e-9)),
  };
}
