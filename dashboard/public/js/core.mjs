// Pure browser helpers: design tokens, formatters, URL parsing, KPI/stat derivation.
// Never touches window/document at import time, so node unit tests can import it.

// Keep in sync with the custom properties in public/css/app.css.
export const TOKENS = Object.freeze({
  light: Object.freeze({
    bg: '#F2F2F7',
    card: '#FFFFFF',
    ink: '#1C1C1E',
    ink2: '#6E6E73',
    ink3: '#8E8E93',
    grid: '#E5E5EA',
    track: '#E9E9EE',
    weight: '#5E5CE6',
    calories: '#1E9E3C',
    protein: '#0A84FF',
    carbs: '#B86E00',
    fat: '#FF4F79',
    ftp: '#14A3B8',
    over: '#E06100',
  }),
  dark: Object.freeze({
    bg: '#191919',
    card: '#232325',
    ink: '#F2F2F7',
    ink2: '#98989D',
    ink3: '#6C6C70',
    grid: '#2C2C2E',
    track: '#38383A',
    weight: '#7D7AFF',
    calories: '#30D158',
    protein: '#409CFF',
    carbs: '#FFB340',
    fat: '#FF6482',
    ftp: '#40C8E0',
    over: '#FF9F0A',
  }),
});

export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const VIEWS = Object.freeze(['all', 'today', 'weight', 'timeline', 'weekly', 'milestones', 'calories', 'balance', 'protein', 'calendar', 'ftp', 'rules']);
export const RANGES = Object.freeze([7, 30, 90, 365]);
export const THEMES = Object.freeze(['light', 'dark']);
export const DEFAULT_RANGE = 30;
export const REFRESH_MS = 15 * 60 * 1000;

export const RANGE_LABELS = Object.freeze({ 7: '7D', 30: '30D', 90: '90D', 365: '1Y' });
const RANGE_LONG = Object.freeze({ 7: '7 days', 30: '30 days', 90: '90 days', 365: '1 year' });

// Card registry, in "all" view order. `n` is the card number shown in its title (so "card 3" is
// unambiguous); the KPI tiles use letters instead. `ranged` cards show the range toggle when embedded alone.
export const CARDS = Object.freeze([
  { view: 'today', n: 1, title: 'Today', accent: 'calories', ranged: false },
  { view: 'calories', n: 2, title: 'Calories', accent: 'calories', ranged: true },
  { view: 'balance', n: 3, title: 'Energy balance', accent: 'calories', ranged: true },
  { view: 'weight', n: 4, title: 'Road to goal', accent: 'weight', ranged: false },
  { view: 'timeline', n: 5, title: 'Timeline', accent: 'weight', ranged: false },
  { view: 'weekly', n: 6, title: 'Weekly check-ins', accent: 'weight', ranged: false },
  { view: 'milestones', n: 7, title: 'Finish lines', accent: 'weight', ranged: false },
  { view: 'protein', n: 8, title: 'Protein', accent: 'protein', ranged: true },
  { view: 'calendar', n: 9, title: 'Logging', accent: 'calories', ranged: false },
  { view: 'ftp', n: 10, title: 'FTP', accent: 'ftp', ranged: false },
  { view: 'rules', n: 11, title: 'Ground rules', accent: 'weight', ranged: false },
]);

export function cardsFor(view) {
  return view === 'all' ? CARDS : CARDS.filter((c) => c.view === view);
}

export function parseParams(search) {
  const q = new URLSearchParams(typeof search === 'string' ? search : '');
  const theme = q.get('theme');
  const view = q.get('view');
  const range = Number(q.get('range'));
  return {
    theme: THEMES.includes(theme) ? theme : null,
    view: VIEWS.includes(view) ? view : 'all',
    range: q.has('range') && RANGES.includes(range) ? range : DEFAULT_RANGE,
    demo: q.get('demo') === '1',
  };
}

export function tokenFromPath(pathname) {
  const m = /^\/d\/([^/?#]+)\/?$/.exec(String(pathname ?? ''));
  return m ? m[1] : null;
}

// Query string for /api/dashboard.
export function apiQuery({ range, demo }) {
  return `?range=${RANGES.includes(range) ? range : DEFAULT_RANGE}${demo ? '&demo=1' : ''}`;
}

// ---- Formatters. Missing values render as an em dash. ----
const DASH = '—';
const MINUS = '−';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtInt(v) {
  return isNum(v) ? intFmt.format(Math.round(v)).replace('-', MINUS) : DASH;
}

export function fmtKg(v) {
  return isNum(v) ? v.toFixed(1).replace('-', MINUS) : DASH;
}

// Signed value with an optional unit: "+0.4 kg", "−0.9 kg", "0.0 kg".
export function fmtSigned(v, unit = '', digits = 1) {
  if (!isNum(v)) return DASH;
  const abs = Math.abs(v);
  let body = digits === 0 ? intFmt.format(Math.round(abs)) : abs.toFixed(digits);
  const zero = Number(body.replace(/,/g, '')) === 0;
  const sign = zero ? '' : v < 0 ? MINUS : '+';
  body = sign + body;
  return unit ? `${body} ${unit}` : body;
}

function parseDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

// "2026-10-26" -> "Oct 26" (no timezone math: the day is already a calendar date).
export function fmtDay(day) {
  const p = parseDay(day);
  return p ? `${MONTHS[p.m - 1]} ${p.d}` : DASH;
}

// "Oct 26", or "Jun 14, 2027" when the year differs from the reference day's year.
export function fmtDayYear(day, refDay) {
  const p = parseDay(day);
  if (!p) return DASH;
  const r = parseDay(refDay);
  return r && r.y === p.y ? fmtDay(day) : `${fmtDay(day)}, ${p.y}`;
}

// "2027-03-05" -> "Mar 2027".
export function fmtMonthYear(day) {
  const p = parseDay(day);
  return p ? `${MONTHS[p.m - 1]} ${p.y}` : DASH;
}

// "2026-10-26" -> "Monday, Oct 26".
export function fmtLongDay(day) {
  const p = parseDay(day);
  if (!p) return DASH;
  const wd = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return `${WEEKDAYS[wd]}, ${fmtDay(day)}`;
}

// Wall-clock time of a Date, e.g. "9:41 AM".
export function fmtTime(date) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
}

export function rangeLong(range) {
  return RANGE_LONG[range] || `${range} days`;
}

// ---- Derived numbers for KPI tiles and card headlines (pure, from /api/dashboard JSON). ----

function addDays(day, n) {
  const p = parseDay(day);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return t.toISOString().slice(0, 10);
}

// Average calories over logged (complete, past) days in the 7 days ending today.
export function sevenDayAvg(data) {
  const days = data?.nutrition?.days || [];
  if (!data?.today) return { avg: null, goal: null, n: 0 };
  const from = addDays(data.today, -6);
  const win = days.filter((d) => d.day >= from && d.day <= data.today && d.status === 'logged');
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const goals = win.map((d) => d.goal_calories).filter(isNum);
  return { avg: mean(win.map((d) => d.calories).filter(isNum)), goal: mean(goals), n: win.length };
}

// Secondary line under the live weight: the smoothed trend and its change over the range.
function weightCaption(w, range) {
  const parts = [];
  if (isNum(w.current_trend_kg)) parts.push(`Trend ${fmtKg(w.current_trend_kg)}`);
  if (isNum(w.range_change_kg)) parts.push(`${fmtSigned(w.range_change_kg, 'kg')} in ${rangeLong(range)}`);
  return parts.join(' · ');
}

export function kpis(data) {
  const w = data?.weight || {};
  const s = data?.nutrition?.summary || {};
  const range = data?.range_days;
  const week = sevenDayAvg(data);

  let goalValue = fmtKg(w.to_goal_kg);
  let goalUnit = 'kg';
  let goalCaption = 'No goal set';
  if (isNum(w.to_goal_kg) && w.to_goal_kg <= 0) {
    goalValue = 'Reached';
    goalUnit = '';
    goalCaption = `Goal ${fmtKg(data?.goals?.target_weight_kg)} kg`;
  } else if (w.road?.windows?.length) {
    // Same date as the Timeline card, so the two never disagree.
    goalCaption = `Likely ${fmtMonthYear(w.road.windows.find((x) => x.key === 'likely').date)}`;
  } else if (w.projection?.plan_date) {
    goalCaption = `Plan date ${fmtDayYear(w.projection.plan_date, data.today)}`;
  } else if (isNum(w.to_goal_kg)) {
    goalCaption = `Goal ${fmtKg(data?.goals?.target_weight_kg)} kg`;
  }

  return [
    {
      key: 'weight',
      id: 'A',
      accent: 'weight',
      label: 'Weight',
      value: fmtKg(w.current_kg),
      unit: 'kg',
      caption: weightCaption(w, range) || 'Not enough weigh-ins',
    },
    { key: 'goal', id: 'B', accent: 'weight', label: 'To goal', value: goalValue, unit: goalUnit, caption: goalCaption },
    {
      key: 'calories',
      id: 'C',
      accent: 'calories',
      label: '7-day average',
      value: fmtInt(week.avg),
      unit: 'kcal',
      caption:
        isNum(week.avg) && isNum(week.goal)
          ? `${fmtSigned(week.avg - week.goal, '', 0)} vs ${fmtInt(week.goal)} goal`
          : 'No complete days logged',
    },
    {
      key: 'cycling',
      id: 'D',
      accent: 'ftp',
      label: 'Cycling',
      value: fmtInt(data?.cycling?.week_kj),
      unit: 'kJ',
      caption: isNum(data?.cycling?.today_kj) ? `Last 7 days · ${fmtInt(data.cycling.today_kj)} kJ today` : 'Last 7 days',
    },
  ];
}

// Whole-percent label ("37%"), or an em dash when there is no value.
export function fmtPct(v) {
  return isNum(v) ? `${Math.round(v)}%` : DASH;
}

// The protein target band as text ("35–40%"), or null when the goals carry no band (D12).
export function proteinBand(data) {
  const g = data?.goals || {};
  return isNum(g.protein_pct_min) && isNum(g.protein_pct_max) ? `${g.protein_pct_min}–${g.protein_pct_max}%` : null;
}

const hasNutrition = (data) => (data?.nutrition?.days || []).some((d) => d.status !== 'missing');

// Headline number shown at the top of each card (Apple Health style).
export function cardStat(view, data) {
  const w = data?.weight || {};
  const s = data?.nutrition?.summary || {};
  const range = data?.range_days;
  switch (view) {
    case 'today': {
      const t = data?.today_rings || {};
      return {
        value: fmtInt(t.calories),
        unit: isNum(t.goal_calories) ? `/ ${fmtInt(t.goal_calories)} kcal` : 'kcal',
        caption: isNum(t.protein_pct) ? `Protein ${fmtPct(t.protein_pct)} of calories` : 'No protein logged yet',
      };
    }
    case 'weight':
      return {
        value: fmtKg(w.current_kg),
        unit: 'kg',
        caption: weightCaption(w, range) || `Last ${rangeLong(range)}`,
      };
    case 'calories':
      return {
        value: fmtInt(s.avg_calories),
        unit: 'kcal avg',
        caption: isNum(s.avg_goal_calories)
          ? `Goal ${fmtInt(s.avg_goal_calories)} · ${s.days_logged ?? 0} days logged`
          : `${s.days_logged ?? 0} days logged`,
      };
    case 'protein':
      return {
        value: fmtPct(s.avg_protein_pct),
        unit: 'of calories avg',
        caption: proteinBand(data) ? `Target ${proteinBand(data)}` : `Last ${rangeLong(range)}`,
      };
    case 'calendar': {
      const days = data?.calendar?.days || [];
      const under = days.filter((d) => d.status === 'under').length;
      const over = days.filter((d) => d.status === 'over').length;
      return { value: fmtInt(under + over), unit: 'days logged', caption: `${fmtInt(under)} at or under goal · since ${fmtDay(data?.calendar?.start)}` };
    }
    case 'ftp': {
      const c = data?.ftp?.current;
      return {
        value: c ? c.wkg.toFixed(2) : DASH,
        unit: 'W/kg',
        caption: c ? `FTP ${fmtInt(c.ftp_w)} W` : 'No FTP tests yet',
      };
    }
    case 'timeline': {
      const road = w.road;
      const win = (key) => road?.windows?.find((x) => x.key === key);
      if (!road) return { value: DASH, unit: '', caption: '' };
      if (!road.windows.length) return { value: 'Reached', unit: '', caption: `Goal ${fmtKg(data?.goals?.target_weight_kg)} kg` };
      return {
        value: fmtMonthYear(win('likely').date),
        unit: 'likely',
        caption: `Brisk ${fmtMonthYear(win('brisk').date)} · Gentle ${fmtMonthYear(win('gentle').date)}`,
      };
    }
    case 'weekly': {
      const wk = w.road?.weeks?.[0];
      if (!wk) return { value: DASH, unit: '', caption: '' };
      return {
        value: isNum(wk.change_kg) ? fmtSigned(wk.change_kg, 'kg') : DASH,
        unit: 'last week',
        caption: `Week ending ${fmtDay(wk.week_end)} · ${wk.weigh_ins || 'no'} weigh-ins`,
      };
    }
    case 'milestones': {
      const lines = w.road?.finish_lines || [];
      if (!lines.length) return { value: DASH, unit: '', caption: '' };
      const next = lines.find((l) => !l.reached);
      const reached = lines.filter((l) => l.reached).length;
      return {
        value: next ? fmtKg(next.kg) : 'All reached',
        unit: next ? 'kg next' : '',
        caption: `${reached} of ${lines.length} reached${next ? ` · about ${fmtMonthYear(next.date)}` : ''}`,
      };
    }
    case 'rules':
      return { value: '', unit: '', caption: '' };
    default:
      return { value: DASH, unit: '', caption: '' };
  }
}

// One line under the timeline: when it was set, when it next moves, and where the pace came from.
export function timelineNote(data) {
  const road = data?.weight?.road;
  if (!road) return '';
  const { mode, actual_kg_per_week: actual, cap_kg_per_week: cap } = road.pace;
  const why =
    mode === 'planning'
      ? 'Planning pace for now. Once you have four weeks of steady weigh-ins, this uses your real pace instead.'
      : mode === 'fast'
        ? `You are losing faster than the plan. The dates stay capped at ${cap} kg a week and do not move sooner. Eat enough and recover well.`
        : `Based on your last four weeks: ${actual.toFixed(2)} kg a week.`;
  return `Set from the ${fmtDay(road.snapshot_day)} check-in (trend ${fmtKg(road.snapshot_trend_kg)} kg). Next update ${fmtDay(road.next_update)}. ${why}`;
}

// Progress bar from the start weight to the goal, measured with the live scale reading.
export function goalProgress(data) {
  const w = data?.weight || {};
  const goal = data?.goals?.target_weight_kg;
  const start = w.road?.start_kg;
  if (!isNum(w.current_kg) || !isNum(goal) || !isNum(start)) return null;
  const span = start - goal;
  const pct = span > 0 ? Math.max(0, Math.min(1, (start - w.current_kg) / span)) : 1;
  return {
    pct,
    left: `Start ${fmtKg(start)} kg`,
    right: w.current_kg > goal ? `${fmtKg(w.current_kg - goal)} kg to ${fmtKg(goal)}` : 'Goal reached',
  };
}

export const ROAD_NOTE =
  'Dots are single weigh-ins. The line is your trend. The shaded band is the planned window from the last Sunday check-in.';

export function groundRules(data) {
  const cap = data?.weight?.road?.pace?.cap_kg_per_week ?? data?.goals?.plan_kg_per_week;
  return [
    'Read the trend, not the scale. A day-to-day swing of a kilo or more is normal water and food weight.',
    `The date only moves on Sundays, and it never plans faster than ${cap} kg a week.`,
    'If you catch yourself weighing several times a day or cutting hard to pull the date in, pause and talk to your doctor or a dietitian.',
  ];
}

// Empty-state message for a card, or null when the card has data to draw.
export function emptyMessage(view, data) {
  switch (view) {
    case 'weight':
      return (data?.weight?.road?.series || []).length >= 2 ? null : 'Not enough weigh-ins yet';
    case 'timeline':
    case 'weekly':
    case 'milestones':
      return data?.weight?.road ? null : 'Not enough weigh-ins yet';
    case 'calories':
    case 'balance':
      return (data?.nutrition?.days || []).some((d) => d.deficit_kcal != null) ? null : 'No complete days logged in this range';
    case 'protein':
      return hasNutrition(data) ? null : 'No food logged in this range';
    case 'calendar':
      return (data?.calendar?.days || []).some((d) => d.status === 'under' || d.status === 'over')
        ? null
        : 'No complete days logged yet';
    case 'ftp':
      return (data?.ftp?.tests || []).length ? null : 'No FTP tests yet';
    default:
      return null;
  }
}

// Shared ECharts base option. Chart builders (T6/T7) extend this.
export function baseOption({ tokens, reducedMotion }) {
  return {
    animation: !reducedMotion,
    animationDuration: reducedMotion ? 0 : 600,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT_STACK, color: tokens.ink2 },
    series: [],
  };
}
