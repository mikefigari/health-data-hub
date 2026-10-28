// Pure aggregation: raw daily inputs -> dashboard JSON contract. No SQL, no HTTP, no clock.
// Rounding rule: compute at full precision, round only on output.

const DAY_MS = 86400000;
const TREND_ALPHA = 0.1;
const TREND_GAP_DAYS = 30;
const CALENDAR_DAYS = 182;
// Food logging began here; the calendar never reaches further back.
const LOGGING_START = '2026-10-25';
const MAX_PROJECTION_DAYS = 1095;

const ms = (d) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (day, n) => new Date(ms(day) + n * DAY_MS).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((ms(a) - ms(b)) / DAY_MS);
const mondayOf = (day) => addDays(day, -((new Date(ms(day)).getUTCDay() + 6) % 7));
const dkey = (v) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const rnd = (x, dp) => {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f + 0; // + 0 normalises -0
};
const r0 = (x) => rnd(x, 0);
const r1 = (x) => rnd(x, 1);
const r2 = (x) => rnd(x, 2);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function effectiveGoal(goals, day) {
  let best = null;
  for (const g of goals) if (g.from <= day && (!best || g.from >= best.from)) best = g;
  return best;
}

function buildTrend(weights) {
  const trend = []; // chronological [{day, kg}] at full precision
  const byDay = new Map();
  let prev = null;
  let t = null;
  const put = (day, kg) => {
    trend.push({ day, kg });
    byDay.set(day, kg);
  };
  for (const w of weights) {
    if (!prev || diffDays(w.day, prev.day) > TREND_GAP_DAYS) {
      t = w.kg;
      put(w.day, t);
    } else {
      const gap = diffDays(w.day, prev.day);
      for (let k = 1; k <= gap; k++) {
        const v = prev.kg + ((w.kg - prev.kg) * k) / gap;
        t = t + TREND_ALPHA * (v - t);
        put(addDays(prev.day, k), t);
      }
    }
    prev = w;
  }
  return { trend, byDay };
}

export function buildDashboard(inputs) {
  const today = inputs.today;
  const rangeDays = inputs.rangeDays;
  const planKgPerWeek = num(inputs.planKgPerWeek);
  const pMin = num(inputs.proteinPctMin) ?? 35;
  const pMax = num(inputs.proteinPctMax) ?? 40;
  const pctOf = (p, cal) => (cal > 0 ? Math.round(((4 * (p ?? 0)) / cal) * 1000) / 10 : null);
  const inBand = (pct) => pct != null && pct >= pMin && pct <= pMax;
  const rangeStart = addDays(today, -(rangeDays - 1));

  const goals = (inputs.goals || [])
    .map((g) => ({
      from: dkey(g.effective_from),
      target: num(g.target_weight_kg),
      base: num(g.base_calories),
      factor: num(g.cycling_kj_factor) ?? 0,
    }))
    .sort((a, b) => (a.from < b.from ? -1 : 1));

  const kjByDay = new Map();
  for (const r of inputs.rideKj || []) {
    const d = dkey(r.day);
    kjByDay.set(d, (kjByDay.get(d) || 0) + (num(r.kj) || 0));
  }
  const nutByDay = new Map();
  for (const r of inputs.nutrition || []) nutByDay.set(dkey(r.day), r);

  const fallbackGoals = (day) => {
    const g = effectiveGoal(goals, day);
    if (!g) return { cal: null };
    const cal = g.base == null ? null : g.base + Math.round(g.factor * (kjByDay.get(day) || 0));
    return { cal };
  };

  // Per-day evaluation at full precision.
  const evalDay = (day) => {
    const row = nutByDay.get(day) || null;
    const calories = row ? num(row.calories) : null;
    const hasCal = calories != null && calories > 0;
    let status = 'missing';
    if (hasCal) {
      if (row.logged_complete === false) status = 'incomplete';
      else if (day === today) status = 'partial';
      else status = 'logged';
    }
    const fb = fallbackGoals(day);
    return {
      day,
      row,
      status,
      counted: hasCal && row.logged_complete !== false,
      calories,
      p: row ? num(row.protein_g) : null,
      c: row ? num(row.carbs_g) : null,
      f: row ? num(row.fat_g) : null,
      goalCal: (row ? num(row.goal_calories) : null) ?? fb.cal,
    };
  };

  const days = [];
  for (let i = 0; i < rangeDays; i++) days.push(evalDay(addDays(rangeStart, i)));

  const kcalParts = (d) => {
    const kp = (d.p ?? 0) * 4;
    const kc = (d.c ?? 0) * 4;
    const kf = (d.f ?? 0) * 9;
    const ko = Math.max((d.calories ?? 0) - (Math.round(kp) + Math.round(kc) + Math.round(kf)), 0);
    return { kp, kc, kf, ko };
  };

  const dayRows = days.map((d) => {
    const has = d.status !== 'missing';
    const pct = d.status === 'logged' || d.status === 'partial' ? pctOf(d.p, d.calories) : null;
    const k = kcalParts(d);
    return {
      day: d.day,
      status: d.status,
      calories: has ? r0(d.calories) : null,
      protein_g: has ? r1(d.p ?? 0) : null,
      carbs_g: has ? r1(d.c ?? 0) : null,
      fat_g: has ? r1(d.f ?? 0) : null,
      kcal_protein: has ? r0(k.kp) : null,
      kcal_carbs: has ? r0(k.kc) : null,
      kcal_fat: has ? r0(k.kf) : null,
      kcal_other: has ? r0(k.ko) : null,
      goal_calories: r0(d.goalCal),
      protein_pct: pct,
      protein_in_range: inBand(pct),
    };
  });

  const weightedPct = (list) => {
    const cal = list.reduce((a, d) => a + d.calories, 0);
    if (!list.length || cal <= 0) return null;
    return r1((list.reduce((a, d) => a + 4 * (d.p ?? 0), 0) / cal) * 100);
  };
  const logged = days.filter((d) => d.status === 'logged');
  const withGoalCal = logged.filter((d) => d.goalCal != null);
  const summary = {
    days_logged: logged.length,
    avg_calories: r0(avg(logged.map((d) => d.calories))),
    avg_goal_calories: r0(avg(withGoalCal.map((d) => d.goalCal))),
    avg_balance_kcal: r0(avg(withGoalCal.map((d) => d.calories - d.goalCal))),
    avg_protein_pct: weightedPct(logged),
    protein_days_in_range: logged.filter((d) => inBand(pctOf(d.p, d.calories))).length,
    calorie_days_met: withGoalCal.filter((d) => d.calories <= d.goalCal).length,
  };

  // Weeks (Monday start) overlapping the range; averages over logged days in range.
  const weeks = [];
  for (let ws = mondayOf(rangeStart); ws <= today; ws = addDays(ws, 7)) {
    const inWeek = logged.filter((d) => d.day >= ws && d.day < addDays(ws, 7));
    const parts = inWeek.map(kcalParts);
    weeks.push({
      week_start: ws,
      days_logged: inWeek.length,
      avg_calories: r0(avg(inWeek.map((d) => d.calories))),
      avg_protein_pct: weightedPct(inWeek),
      avg_kcal_protein: r0(avg(parts.map((k) => k.kp))),
      avg_kcal_carbs: r0(avg(parts.map((k) => k.kc))),
      avg_kcal_fat: r0(avg(parts.map((k) => k.kf))),
      avg_kcal_other: r0(avg(parts.map((k) => k.ko))),
      avg_goal_calories: r0(avg(inWeek.filter((d) => d.goalCal != null).map((d) => d.goalCal))),
    });
  }

  // Calendar: up to 182 days ending today, starting no earlier than LOGGING_START.
  const calStartRaw = addDays(today, -(CALENDAR_DAYS - 1));
  const loggingStart = inputs.loggingStart === undefined ? LOGGING_START : inputs.loggingStart; // null = no floor (demo)
  const calStart = loggingStart && calStartRaw < loggingStart ? loggingStart : calStartRaw;
  const calDays = [];
  for (let i = 0; i <= diffDays(today, calStart); i++) {
    const d = evalDay(addDays(calStart, i));
    let status = 'none';
    if (d.day === today) status = 'today';
    else if (d.counted && d.goalCal != null) status = d.calories <= d.goalCal ? 'under' : 'over';
    calDays.push({
      day: d.day,
      status,
      protein_in_range: Boolean(d.counted && inBand(pctOf(d.p, d.calories))),
    });
  }

  // Cycling energy (kJ) from power-meter rides.
  const kjSum = (from) => {
    let t = 0;
    for (let i = 0; i <= diffDays(today, from); i++) t += kjByDay.get(addDays(from, i)) || 0;
    return r0(t);
  };
  const cycling = { today_kj: kjSum(today), week_kj: kjSum(addDays(today, -6)), range_kj: kjSum(rangeStart) };

  // Today rings.
  const td = evalDay(today);
  const todayLogged = td.calories != null && td.calories > 0;
  const today_rings = {
    calories: todayLogged ? r0(td.calories) : 0,
    goal_calories: r0(td.goalCal),
    protein_pct: todayLogged ? pctOf(td.p, td.calories) : 0,
    protein_g: todayLogged ? r0(td.p ?? 0) : 0,
    logged: todayLogged,
  };

  // Weight.
  const wmap = new Map();
  for (const w of inputs.weights || []) {
    const kg = num(w.kg);
    const d = dkey(w.day);
    if (kg != null && d <= today) wmap.set(d, kg);
  }
  const weights = [...wmap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, kg]) => ({ day, kg }));
  const { trend, byDay } = buildTrend(weights);
  const last = weights.at(-1) || null;
  const currentTrend = last ? byDay.get(last.day) : null;
  const trendInRange = trend.filter((p) => p.day >= rangeStart && p.day <= today);
  const prior = last ? byDay.get(addDays(last.day, -14)) : undefined;
  const weeklyRate = currentTrend != null && prior != null ? (currentTrend - prior) / 2 : null;
  const rangeChange = trendInRange.length >= 2 ? trendInRange.at(-1).kg - trendInRange[0].kg : null;

  const goalNow = effectiveGoal(goals, today);
  const target = goalNow ? goalNow.target : null;
  // Distance to goal and the projections run off the latest scale reading, not the smoothed trend.
  const toGoal = last && target != null ? last.kg - target : null;
  let planDate = null;
  let currentRateDate = null;
  if (toGoal != null && toGoal > 0 && last) {
    if (planKgPerWeek > 0) planDate = addDays(last.day, Math.ceil((toGoal / planKgPerWeek) * 7));
    if (weeklyRate != null && weeklyRate < 0) {
      const n = Math.ceil((toGoal / -weeklyRate) * 7);
      if (n <= MAX_PROJECTION_DAYS) currentRateDate = addDays(last.day, n);
    }
  }

  // FTP (ignores rangeDays).
  const tests = (inputs.ftp || [])
    .map((t) => ({ day: dkey(t.day), ftp_w: num(t.ftp_w) }))
    .filter((t) => t.ftp_w != null)
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  const ftpFor = (day) => {
    let v = null;
    for (const t of tests) if (t.day <= day) v = t.ftp_w;
    return v;
  };
  const series = [];
  if (tests.length) {
    for (const w of weights) {
      if (w.day < tests[0].day) continue;
      const f = ftpFor(w.day);
      series.push({ day: w.day, ftp_w: f, weight_kg: r2(w.kg), wkg: r2(f / w.kg) });
    }
  }
  const latestFtp = tests.length ? tests.at(-1).ftp_w : null;

  return {
    today,
    range_days: rangeDays,
    goals: {
      target_weight_kg: target,
      base_calories: goalNow ? goalNow.base : null,
      protein_pct_min: pMin,
      protein_pct_max: pMax,
      plan_kg_per_week: planKgPerWeek,
    },
    today_rings,
    cycling,
    weight: {
      scale: weights.filter((w) => w.day >= rangeStart).map((w) => ({ day: w.day, kg: r2(w.kg) })),
      trend: trendInRange.map((p) => ({ day: p.day, kg: r2(p.kg) })),
      current_kg: last ? r2(last.kg) : null,
      current_trend_kg: r2(currentTrend),
      last_weigh_in_day: last ? last.day : null,
      days_since_weigh_in: last ? diffDays(today, last.day) : null,
      range_change_kg: r2(rangeChange),
      weekly_rate_kg: r2(weeklyRate),
      to_goal_kg: r2(toGoal),
      projection: { plan_date: planDate, current_rate_date: currentRateDate },
    },
    nutrition: { days: dayRows, weeks, summary },
    calendar: { start: calStart, end: today, days: calDays },
    ftp: {
      tests: tests.map((t) => ({ day: t.day, ftp_w: t.ftp_w })),
      series,
      current:
        latestFtp != null && currentTrend != null
          ? { ftp_w: latestFtp, wkg: r2(latestFtp / currentTrend) }
          : null,
    },
  };
}
