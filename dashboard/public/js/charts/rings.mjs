// Today rings: Apple-Activity-style progress ring as an ECharts gauge. Pure builder.
// The center label is HTML laid over the chart, computed by ringLabel().
import { fmtInt } from '../core.mjs';
import { frame, isNum, withAlpha } from './common.mjs';

const RING_WIDTH = 16;
const TRACK_ALPHA = 0.16;

function ring(tokens, { value, max, color, track, z }) {
  return {
    type: 'gauge',
    startAngle: 90,
    endAngle: -270,
    min: 0,
    max,
    radius: '90%',
    center: ['50%', '50%'],
    z,
    silent: true,
    progress: { show: true, roundCap: true, width: RING_WIDTH, itemStyle: { color } },
    axisLine: {
      show: Boolean(track),
      roundCap: true,
      lineStyle: { width: RING_WIDTH, color: [[1, track || 'rgba(0, 0, 0, 0)']] },
    },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { show: false },
    pointer: { show: false },
    anchor: { show: false },
    title: { show: false },
    detail: { show: false },
    data: [{ value }],
  };
}

export function ringOption(d, tokens, opts = {}) {
  const color = tokens[opts.accent] || tokens.calories;
  const value = isNum(d?.value) ? Math.max(0, d.value) : 0;
  const goal = isNum(d?.goal) && d.goal > 0 ? d.goal : Math.max(value, 1);
  const series = [ring(tokens, { value: Math.min(value, goal), max: goal, color, track: withAlpha(color, TRACK_ALPHA), z: 2 })];
  if (value > goal) {
    // Second lap in the "over" color, drawn on top of the full first lap.
    series.push(ring(tokens, { value: Math.min(value - goal, goal), max: goal, color: tokens.over, track: null, z: 3 }));
  }
  return { ...frame(tokens, opts), series };
}

export function ringLabel(d, { unit = 'kcal' } = {}) {
  const value = isNum(d?.value) ? d.value : null;
  const goal = isNum(d?.goal) ? d.goal : null;
  if (goal === null) return { big: fmtInt(value), small: unit, caption: 'No goal set' };
  const left = goal - (value ?? 0);
  return {
    big: fmtInt(value),
    small: `of ${fmtInt(goal)} ${unit}`,
    caption: left >= 0 ? `${fmtInt(left)} left` : `${fmtInt(-left)} over`,
  };
}
