// Logging calendar (GitHub / Oura style): 26 weeks of rounded day cells colored by whether
// the day came in at or under the calorie goal. Pure builder.
import { fmtDay, proteinBand } from '../core.mjs';
import { frame } from './common.mjs';

// A 182-day range needs at most 27 week columns (26 full weeks + a partial lead week).
const COLS = 27;
const GAP = 2; // card-colored cell border = visual gap
const LEFT = 30; // weekday labels
const TOP = 20; // month labels
const MIN_CELL = 4;
const MAX_CELL = 18;
const FIRST_DAY = 1; // Monday, matching the API's Monday-start weeks

const STATUS_LABEL = {
  under: 'At or under goal',
  over: 'Over goal',
  today: 'Today · in progress',
  none: 'Not logged',
};

// Cell size in px so COLS columns of (cell + gap) plus the label margin fit widthPx.
export function calendarCellSize(widthPx) {
  const w = Number(widthPx) || 0;
  const cell = Math.floor((w - LEFT) / COLS - GAP);
  return Math.min(MAX_CELL, Math.max(MIN_CELL, cell));
}

// Chart height that fits 7 rows of cells plus the month labels.
export function calendarHeight(widthPx) {
  return TOP + 7 * calendarCellSize(widthPx) + 6;
}

// Today is drawn hollow (card fill) with an ink outline: it is still in progress.
const statusColors = (tokens) => ({ under: tokens.calories, over: tokens.over, today: tokens.card, none: tokens.track });
const STATUSES = ['under', 'over', 'today', 'none'];

// HTML legend entries shown under the calendar (today is outlined, so it needs no swatch).
export function calendarLegend(tokens) {
  const c = statusColors(tokens);
  return [
    { key: 'under', label: STATUS_LABEL.under, color: c.under },
    { key: 'over', label: STATUS_LABEL.over, color: c.over },
    { key: 'none', label: STATUS_LABEL.none, color: c.none },
  ];
}

export function calendarOption(data, tokens, opts = {}) {
  const cal = data?.calendar;
  const days = cal?.days || [];
  if (!cal?.start || !cal?.end || !days.length) return { empty: 'No complete days logged yet' };
  const width = opts.width ?? 358;
  const cell = calendarCellSize(width);
  const colors = statusColors(tokens);
  const radius = Math.max(3, Math.round(cell * 0.3));
  const [startY, startM, startD] = cal.start.split('-').map(Number);

  const series = {
    name: 'calendar',
    type: 'heatmap',
    coordinateSystem: 'calendar',
    // Cell value is [day, status, code]: ECharts skips heatmap cells whose value dimension is
    // not numeric, so the numeric status code drives rendering and the visualMap reads status.
    encode: { time: 0, value: 2 },
    itemStyle: { borderRadius: radius, borderWidth: GAP, borderColor: tokens.card },
    emphasis: { itemStyle: { borderColor: tokens.ink2, borderWidth: GAP } },
    data: days.map((d) => {
      const status = STATUSES.includes(d.status) ? d.status : 'none';
      const value = [d.day, status, STATUSES.indexOf(status)];
      return status === 'today'
        ? { value, itemStyle: { color: colors.today, borderColor: tokens.ink2, borderWidth: GAP } }
        : { value };
    }),
  };

  const proteinByDay = new Map(days.map((d) => [d.day, d.protein_in_range]));
  const band = proteinBand(data);
  const tooltip = {
    trigger: 'item',
    triggerOn: 'mousemove|click',
    confine: true,
    backgroundColor: tokens.card,
    borderColor: tokens.grid,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: tokens.ink, fontSize: 12 },
    extraCssText: 'border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,0.12);',
    formatter: (p) => {
      const [day, status] = Array.isArray(p?.value) ? p.value : [];
      if (!day) return '';
      const inRange = proteinByDay.get(day);
      // Complete days also say whether protein landed in its % band (D12); today is still in progress.
      const protein = band && (status === 'under' || status === 'over') && typeof inRange === 'boolean'
        ? `<div style="color:${tokens.ink2};margin-top:2px">Protein ${inRange ? 'in' : 'outside'} ${band}</div>`
        : '';
      return `<div style="color:${tokens.ink2};margin-bottom:2px">${fmtDay(day)}</div><b>${STATUS_LABEL[status] || STATUS_LABEL.none}</b>${protein}`;
    },
  };

  return {
    ...frame(tokens, opts),
    tooltip,
    // Categorical status -> color. Hidden: the legend is HTML (calendarLegend) under the chart.
    visualMap: {
      type: 'piecewise',
      show: false,
      dimension: 1,
      seriesIndex: 0,
      pieces: [
        { value: 'under', label: STATUS_LABEL.under, color: colors.under },
        { value: 'over', label: STATUS_LABEL.over, color: colors.over },
        { value: 'today', label: STATUS_LABEL.today, color: colors.today, borderColor: tokens.ink2 },
        { value: 'none', label: STATUS_LABEL.none, color: colors.none },
      ],
    },
    calendar: {
      range: [cal.start, cal.end],
      orient: 'horizontal',
      firstDay: FIRST_DAY,
      cellSize: [cell, cell],
      left: LEFT,
      top: TOP,
      itemStyle: { color: tokens.track, borderWidth: GAP, borderColor: tokens.card, borderRadius: radius },
      splitLine: { show: false },
      yearLabel: { show: false },
      monthLabel: {
        show: true,
        nameMap: 'en',
        color: tokens.ink2,
        fontSize: 10,
        margin: 6,
        align: 'left',
        // Skip the label of a partial first month (under two columns) so it never collides.
        formatter: (p) => (Number(p.yyyy) === startY && Number(p.M) === startM && startD > 14 ? '' : p.nameMap),
      },
      dayLabel: {
        show: true,
        firstDay: FIRST_DAY,
        nameMap: ['', 'Mon', '', 'Wed', '', 'Fri', ''],
        color: tokens.ink2,
        fontSize: 9,
        margin: 4,
      },
      silent: true,
    },
    series: [series],
  };
}
