// Road to goal (Steady Weight): weigh-in dots under a smoothed trend line, the planned window
// (brisk to gentle) fanning out from the last Sunday check-in to the goal line, and a today marker.
import { cardStat, fmtKg } from '../core.mjs';
import {
  addDays,
  axisTooltip,
  dayTs,
  fmtTsDay,
  frame,
  grid,
  isNum,
  timeAxis,
  tipRow,
  valueAxis,
  withAlpha,
} from './common.mjs';

export const EMPTY_WEIGHT = 'Not enough weigh-ins yet';
const TAIL_DAYS = 14; // breathing room after the gentle end of the window
const SHOWN_FUTURE_DAYS = 45; // when the goal is reached or unknown, still show a little future
const fmtGoal = (kg) => (Number.isInteger(kg) ? String(kg) : kg.toFixed(1));

export function weightOption(data, tokens, opts = {}) {
  const road = data?.weight?.road;
  const series = (road?.series || []).filter((p) => p && p.day && isNum(p.kg));
  if (series.length < 2) return { empty: EMPTY_WEIGHT };

  const accent = tokens.weight;
  const goal = data?.goals?.target_weight_kg;
  const today = data.today;
  const windows = road.windows || [];
  const win = (key) => windows.find((w) => w.key === key);
  const snapDay = road.snapshot_day;
  const snapKg = road.snapshot_trend_kg;

  const lastDate = windows.length ? win('gentle').date : addDays(series.at(-1).day, SHOWN_FUTURE_DAYS);
  const xMin = series[0].day;
  const xMax = dayTs(addDays(lastDate, TAIL_DAYS));

  const vals = series.flatMap((p) => [p.kg, p.trend_kg]).filter(isNum);
  if (isNum(goal)) vals.push(goal);
  const min = Math.floor(Math.min(...vals) - 1);
  const max = Math.ceil(Math.max(...vals) + 1);

  const trendSeries = {
    name: 'trend',
    type: 'line',
    data: series.map((p) => [p.day, p.trend_kg]),
    smooth: 0.35,
    smoothMonotone: 'x',
    showSymbol: false,
    z: 3,
    lineStyle: { width: 3, color: accent, cap: 'round' },
    itemStyle: { color: accent },
    emphasis: { focus: 'none' },
    markLine: {
      silent: true,
      symbol: 'none',
      animation: false,
      data: [
        ...(isNum(goal)
          ? [
              {
                yAxis: goal,
                lineStyle: { type: 'dashed', color: accent, width: 1.5 },
                label: { formatter: `Goal ${fmtGoal(goal)} kg`, position: 'insideEndTop', color: accent, fontSize: 11 },
              },
            ]
          : []),
        {
          xAxis: today,
          lineStyle: { type: 'dotted', color: tokens.ink3, width: 1 },
          label: { formatter: 'Today', position: 'insideEndTop', rotate: 0, align: 'left', offset: [4, 0], color: tokens.ink2, fontSize: 11 },
        },
      ],
    },
  };

  const out = [
    {
      name: 'scale',
      type: 'scatter',
      data: series.map((p) => [p.day, p.kg]),
      symbolSize: 6,
      z: 2,
      itemStyle: { color: accent, opacity: 0.4 },
      emphasis: { itemStyle: { opacity: 0.9 } },
    },
    trendSeries,
  ];

  if (windows.length && isNum(goal)) {
    const poly = [
      [snapDay, snapKg],
      [win('brisk').date, goal],
      [win('gentle').date, goal],
    ];
    out.push({
      name: 'window',
      type: 'custom',
      silent: true,
      z: 0,
      tooltip: { show: false },
      data: [0],
      renderItem: (params, api) => ({
        type: 'polygon',
        shape: { points: poly.map(([d, kg]) => api.coord([dayTs(d), kg])) },
        style: { fill: withAlpha(accent, 0.16) },
      }),
    });
    out.push({
      name: 'likely',
      type: 'line',
      data: [[snapDay, snapKg], [win('likely').date, goal]],
      showSymbol: false,
      symbol: 'none',
      z: 1,
      lineStyle: { type: 'dashed', width: 1.5, color: withAlpha(accent, 0.7) },
      tooltip: { show: false },
    });
  }

  const tooltip = axisTooltip(tokens, (params) => {
    const ps = (Array.isArray(params) ? params : [params]).filter((p) => p.seriesName === 'scale' || p.seriesName === 'trend');
    if (!ps.length) return '';
    const head = `<div style="color:${tokens.ink2};margin-bottom:4px">${fmtTsDay(ps[0].axisValue)}</div>`;
    const label = { scale: 'Weigh-in', trend: 'Trend' };
    return head + ps.map((p) => tipRow(p.marker, label[p.seriesName], `${fmtKg(p.value[1])} kg`)).join('');
  });

  return {
    ...frame(tokens, opts),
    grid: grid({ top: 12 }),
    tooltip,
    xAxis: timeAxis(tokens, { min: dayTs(xMin), max: xMax, monthOnly: (xMax - dayTs(xMin)) / 86400000 > 120 }),
    yAxis: valueAxis(tokens, { min, max, splitNumber: 4, axisLabel: { formatter: (v) => String(v) } }),
    series: out,
  };
}

// Card header hero: the live scale reading, with the trend and range change in the caption.
export function weightHero(data) {
  return cardStat('weight', data);
}
