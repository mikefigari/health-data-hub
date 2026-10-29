// Energy balance: deficit (burn - eaten, burn = baseline + ride kJ) per day, or per week for
// 90D/1Y, against the target deficit line. Pure builder.
import { fmtDay, fmtInt } from '../core.mjs';
import { axisTooltip, frame, grid, isNum, tipRow, valueAxis, withAlpha } from './common.mjs';

export const EMPTY_BALANCE = 'No complete days logged in this range';
const TOP_RADIUS = [6, 6, 0, 0];
const BAR_MAX = 28;

const rangeOf = (data, opts) => opts?.range ?? data?.range_days ?? 30;
const isWeekly = (data, opts) => rangeOf(data, opts) > 30;
export const fmtDeficit = (v) => (isNum(v) ? `${v < 0 ? '+' : '−'}${fmtInt(Math.abs(v))}` : '—');

export function balanceOption(data, tokens, opts = {}) {
  const weekly = isWeekly(data, opts);
  const rows = (weekly ? data?.nutrition?.weeks : data?.nutrition?.days) || [];
  const vals = rows.map((r) => (isNum(r.deficit_kcal) ? r.deficit_kcal : null));
  if (!vals.some(isNum)) return { empty: EMPTY_BALANCE };
  const e = data?.energy || {};
  const target = weekly ? e.week_target_kcal : e.daily_target_kcal;
  const cats = rows.map((r) => (weekly ? r.week_start : r.day));
  const bars = vals.map((v) =>
    v == null ? null : { value: v, itemStyle: { color: v >= 0 ? tokens.calories : tokens.over, borderRadius: v >= 0 ? TOP_RADIUS : [0, 0, 6, 6] } }
  );
  const tooltip = axisTooltip(tokens, (params) => {
    const i = (Array.isArray(params) ? params[0] : params)?.dataIndex;
    const row = rows[i];
    if (!row) return '';
    const head = `<div style="color:${tokens.ink2};margin-bottom:4px">${weekly ? `Week of ${fmtDay(row.week_start)}` : fmtDay(row.day)}</div>`;
    const v = vals[i];
    if (v == null) return head + `<div style="color:${tokens.ink2}">Not logged</div>`;
    const burn = weekly ? row.avg_maintenance_kcal : row.maintenance_kcal;
    const eaten = weekly ? row.avg_calories : row.calories;
    return (
      head +
      tipRow('', v >= 0 ? 'Deficit' : 'Surplus', `${fmtInt(Math.abs(v))} kcal`) +
      tipRow('', weekly ? 'Avg baseline + rides' : 'Baseline + rides', `${fmtInt(burn)} kcal`) +
      tipRow('', weekly ? 'Avg eaten' : 'Eaten', `${fmtInt(eaten)} kcal`)
    );
  });
  const targetLine = {
    name: 'target',
    type: 'line',
    data: cats.map(() => (isNum(target) ? target : null)),
    symbol: 'none',
    silent: true,
    z: 3,
    lineStyle: { type: 'dashed', width: 1.5, color: tokens.ink2 },
    emphasis: { disabled: true },
  };
  return {
    ...frame(tokens, opts),
    grid: grid({ top: 16 }),
    tooltip,
    xAxis: {
      type: 'category',
      data: cats,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: tokens.ink2, fontSize: 11, hideOverlap: true, formatter: (v) => fmtDay(v) },
      axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(tokens.ink3, 0.08) }, label: { show: false } },
    },
    yAxis: valueAxis(tokens, { splitNumber: 4, axisLabel: { formatter: (v) => fmtInt(v) } }),
    series: [{ name: 'deficit', type: 'bar', barMaxWidth: BAR_MAX, barCategoryGap: '30%', z: 2, emphasis: { disabled: true }, data: bars }, targetLine],
  };
}

// Card hero: this week's total deficit (from ride-adjusted baseline) against the weekly target.
export function balanceHero(data) {
  const e = data?.energy || {};
  const unit = isNum(e.week_deficit_kcal) && e.week_deficit_kcal < 0 ? 'kcal surplus this week' : 'kcal deficit this week';
  const parts = [];
  if (isNum(e.week_target_kcal)) parts.push(`Target ${fmtInt(e.week_target_kcal)}/wk`);
  parts.push(`Baseline ${fmtInt(e.maintenance_kcal)} + rides (${fmtInt(e.week_ride_kj)} kJ)`);
  if (isNum(e.goal_base_kcal)) parts.push(`Goal ${fmtInt(e.goal_base_kcal)} + rides`);
  return {
    value: isNum(e.week_deficit_kcal) ? fmtInt(Math.abs(e.week_deficit_kcal)) : '—',
    unit,
    caption: `${parts.join(' · ')} · ${e.week_days_logged ?? 0} days logged`,
  };
}
