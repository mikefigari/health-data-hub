// Weight trend (MacroFactor / Happy Scale style): faint weigh-in dots under a smoothed
// trend line with an accent fade, a dashed plan-pace projection and an optional goal line.
import { cardStat, fmtKg } from '../core.mjs';
import {
  addDays,
  axisTooltip,
  dayTs,
  fadeGradient,
  fmtTsDay,
  frame,
  grid,
  isNum,
  timeAxis,
  tipRow,
  valueAxis,
  withAlpha,
} from './common.mjs';

export const EMPTY_WEIGHT = 'Not enough weigh-ins in this range';
const PLAN_DAYS = 30;
const GOAL_NEAR_KG = 3;

const points = (xs) => (xs || []).filter((p) => p && p.day && isNum(p.kg));
const fmtGoal = (kg) => (Number.isInteger(kg) ? String(kg) : kg.toFixed(1));

// How much future to show after the last point: a quarter of the range, 4..30 days.
const futureDays = (range) => Math.min(PLAN_DAYS, Math.max(4, Math.ceil((range || 30) / 4)));

export function weightOption(data, tokens, opts = {}) {
  const scale = points(data?.weight?.scale);
  const trend = points(data?.weight?.trend);
  if (scale.length < 2) return { empty: EMPTY_WEIGHT };

  const range = opts.range ?? data?.range_days ?? 30;
  const accent = tokens.weight;
  const vals = [...scale, ...trend].map((p) => p.kg);
  let min = Math.floor(Math.min(...vals) - 1);
  let max = Math.ceil(Math.max(...vals) + 1);

  // Goal line only when the goal sits within 3 kg of the data range; then pull it into view.
  const goal = data?.goals?.target_weight_kg;
  const showGoal = isNum(goal) && goal >= min - GOAL_NEAR_KG && goal <= max + GOAL_NEAR_KG;
  if (showGoal) {
    min = Math.min(min, Math.floor(goal - 1));
    max = Math.max(max, Math.ceil(goal + 1));
  }

  const last = trend.at(-1) || scale.at(-1);
  const rate = data?.goals?.plan_kg_per_week;
  const plan = isNum(rate) && rate > 0
    ? [[last.day, last.kg], [addDays(last.day, PLAN_DAYS), Number((last.kg - (PLAN_DAYS * rate) / 7).toFixed(3))]]
    : null;

  const firstDay = [scale[0].day, trend[0]?.day].filter(Boolean).sort()[0];
  const xMax = dayTs(addDays(last.day, plan ? futureDays(range) : 0));

  const trendSeries = {
    name: 'trend',
    type: 'line',
    data: trend.map((p) => [p.day, p.kg]),
    smooth: 0.35,
    smoothMonotone: 'x',
    showSymbol: false,
    symbol: 'circle',
    symbolSize: 8,
    z: 3,
    lineStyle: { width: 3, color: accent, cap: 'round' },
    itemStyle: { color: accent, borderColor: tokens.card, borderWidth: 2 },
    areaStyle: { origin: 'start', color: fadeGradient(accent, 0.25) },
    emphasis: { focus: 'none', scale: true },
  };
  if (showGoal) {
    trendSeries.markLine = {
      silent: true,
      symbol: 'none',
      animation: false,
      lineStyle: { type: 'dashed', color: tokens.ink3, width: 1 },
      label: { formatter: `Goal ${fmtGoal(goal)} kg`, position: 'insideEndTop', color: tokens.ink2, fontSize: 11 },
      data: [{ yAxis: goal }],
    };
  }

  const series = [
    {
      name: 'scale',
      type: 'scatter',
      data: scale.map((p) => [p.day, p.kg]),
      symbolSize: 5,
      z: 2,
      itemStyle: { color: accent, opacity: 0.35 },
      emphasis: { itemStyle: { opacity: 0.8 } },
    },
    trendSeries,
  ];
  if (plan) {
    series.push({
      name: 'plan pace',
      type: 'line',
      data: plan,
      showSymbol: false,
      symbol: 'none',
      z: 1,
      lineStyle: { type: 'dashed', width: 1.5, color: withAlpha(accent, 0.55) },
      itemStyle: { color: withAlpha(accent, 0.55) },
      tooltip: { show: false },
    });
  }

  const tooltip = axisTooltip(tokens, (params) => {
    const ps = (Array.isArray(params) ? params : [params]).filter((p) => p.seriesName !== 'plan pace');
    if (!ps.length) return '';
    const head = `<div style="color:${tokens.ink2};margin-bottom:4px">${fmtTsDay(ps[0].axisValue)}</div>`;
    const label = { scale: 'Weigh-in', trend: 'Trend' };
    return head + ps.map((p) => tipRow(p.marker, label[p.seriesName] || p.seriesName, `${fmtKg(p.value[1])} kg`)).join('');
  });

  return {
    ...frame(tokens, opts),
    grid: grid({ top: 12 }),
    tooltip,
    xAxis: timeAxis(tokens, { min: dayTs(firstDay), max: xMax, monthOnly: range > 120 }),
    yAxis: valueAxis(tokens, { min, max, splitNumber: 4, axisLabel: { formatter: (v) => String(v) } }),
    series,
  };
}

// Card header hero: trend weight with the change over the range.
export function weightHero(data) {
  return cardStat('weight', data);
}
