// Pure "Steady Weight" roadmap: smoothed trend, Sunday check-in snapshot, pace windows to goal,
// weekly check-ins and finish lines. No SQL, no HTTP, no clock. Compute at full precision, round on output.

const DAY_MS = 86400000;
const TREND_DAYS = 7; // time constant of the trend smoother
const PACE_WEEKS = 4; // actual pace is measured over the last 4 weeks
const MIN_PACE_WEIGH_INS = 6;
const MIN_PACE_KG_PER_WEEK = 0.05;
const PLANNING_PACES = Object.freeze({ gentle: 0.35, likely: 0.5, brisk: 0.75 });
const HISTORY_DAYS = 120;
const FINISH_LINE_STEP_KG = 2.5;
const FINISH_LINES = 6;

const ms = (d) => Date.parse(`${d}T00:00:00Z`);
const addDays = (day, n) => new Date(ms(day) + n * DAY_MS).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((ms(a) - ms(b)) / DAY_MS);
const sundayOf = (day) => addDays(day, -new Date(ms(day)).getUTCDay());
const rnd = (x, dp) => {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f + 0; // + 0 normalises -0
};
const r2 = (x) => rnd(x, 2);

// Exponential smoothing that weighs a reading by the days since the previous one, so a long gap
// lets the next reading move the trend further. weights: chronological [{day, kg}].
export function smoothTrend(weights) {
  const out = [];
  let t = null;
  let prev = null;
  for (const w of weights) {
    t = t == null ? w.kg : t + (1 - Math.exp(-Math.max(1, diffDays(w.day, prev)) / TREND_DAYS)) * (w.kg - t);
    prev = w.day;
    out.push({ day: w.day, kg: w.kg, t });
  }
  return out;
}

// Latest trend point on or before `day`, or null if none or older than maxGap days.
export function trendAt(series, day, maxGap = Infinity) {
  let hit = null;
  for (const p of series) {
    if (p.day <= day) hit = p;
    else break;
  }
  return hit && diffDays(day, hit.day) <= maxGap ? hit : null;
}

function actualPace(series, day) {
  const now = trendAt(series, day, 14);
  const from = addDays(day, -7 * PACE_WEEKS);
  const old = trendAt(series, from, 21);
  const n = series.filter((p) => p.day > from && p.day <= day).length;
  return now && old && n >= MIN_PACE_WEIGH_INS ? (old.t - now.t) / PACE_WEEKS : null;
}

// Gentle / likely / brisk kg-per-week, never faster than the cap.
function paces(series, day, cap) {
  const actual = actualPace(series, day);
  if (actual === null || actual <= MIN_PACE_KG_PER_WEEK) {
    return { mode: 'planning', actual, ...PLANNING_PACES, brisk: Math.min(cap, PLANNING_PACES.brisk) };
  }
  const likely = Math.min(cap, Math.max(0.25, actual));
  return {
    mode: actual > cap ? 'fast' : 'measured',
    actual,
    gentle: Math.max(0.2, likely * 0.7),
    likely,
    brisk: Math.min(cap, likely * 1.3),
  };
}

// series: smoothTrend() output. startKg is the weight the progress bar counts from.
export function buildRoadmap({ series, today, target, cap, startKg }) {
  if (!series.length || target == null || !(cap > 0)) return null;
  const latest = trendAt(series, today);
  const snapDay = sundayOf(today);
  const snap = trendAt(series, snapDay, 14) || latest;
  const P = paces(series, snapDay, cap);
  const T = snap.t;
  const daysTo = (kg, pace) => Math.round(((T - kg) / pace) * 7);

  const windows =
    T > target
      ? [
          ['brisk', 'Brisk', P.brisk],
          ['likely', 'Likely', P.likely],
          ['gentle', 'Gentle', P.gentle],
        ].map(([key, label, pace]) => ({ key, label, date: addDays(snapDay, daysTo(target, pace)), kg_per_week: r2(pace) }))
      : [];

  const weeks = [];
  for (let i = 0; i < 4; i++) {
    const end = addDays(snapDay, -7 * i);
    const n = series.filter((p) => p.day > addDays(end, -7) && p.day <= end).length;
    weeks.push({ end, n, t: n ? trendAt(series, end).t : null });
  }

  const finishLines = [];
  for (let k = FINISH_LINES - 1; k >= 0; k--) {
    const kg = target + k * FINISH_LINE_STEP_KG;
    const reached = latest.t <= kg;
    finishLines.push({ kg: r2(kg), reached, date: reached ? null : addDays(snapDay, daysTo(kg, P.likely)) });
  }

  const from = addDays(today, -HISTORY_DAYS);
  return {
    snapshot_day: snapDay,
    snapshot_trend_kg: r2(T),
    next_update: addDays(snapDay, 7),
    trend_kg: r2(latest.t),
    start_kg: r2(startKg),
    pace: { mode: P.mode, actual_kg_per_week: r2(P.actual), cap_kg_per_week: r2(cap) },
    windows,
    weeks: weeks.map((w, i) => ({
      week_end: w.end,
      weigh_ins: w.n,
      trend_kg: r2(w.t),
      change_kg: w.t != null && weeks[i + 1]?.t != null ? r2(w.t - weeks[i + 1].t) : null,
    })),
    finish_lines: finishLines,
    series: series.filter((p) => p.day >= from).map((p) => ({ day: p.day, kg: r2(p.kg), trend_kg: r2(p.t) })),
  };
}
