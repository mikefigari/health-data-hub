// FTP history: FTP as a step line with an accent fade, W/kg on a right axis, and the
// test days as emphasized dots. Pure builder.
import { cardStat, fmtInt } from '../core.mjs';
import { axisTooltip, dayTs, fadeGradient, fmtTsDay, frame, grid, isNum, timeAxis, tipRow, valueAxis } from './common.mjs';

export const EMPTY_FTP = 'No FTP tests yet';
const TICKS = 4;

// Nice [min, max] with exactly TICKS intervals, so the two y-axes share grid lines.
function bounds(vals, pad, step) {
  const lo = Math.floor((Math.min(...vals) - pad) / step) * step;
  let hi = Math.ceil((Math.max(...vals) + pad) / step) * step;
  const span = Math.ceil((hi - lo) / (step * TICKS) - 1e-9) * step * TICKS;
  hi = lo + span;
  return { min: Number(lo.toFixed(4)), max: Number(hi.toFixed(4)), interval: Number((span / TICKS).toFixed(4)) };
}

export function ftpOption(data, tokens, opts = {}) {
  const tests = (data?.ftp?.tests || []).filter((t) => t && t.day && isNum(t.ftp_w));
  if (!tests.length) return { empty: EMPTY_FTP };
  const series = (data?.ftp?.series || []).filter((p) => p && p.day && isNum(p.ftp_w));
  const today = data?.today;

  // FTP holds until the next test: use the daily series, or the tests extended to today.
  const ftpPts = series.length
    ? series.map((p) => [p.day, p.ftp_w])
    : [...tests.map((t) => [t.day, t.ftp_w]), ...(today && today > tests.at(-1).day ? [[today, tests.at(-1).ftp_w]] : [])];
  const wkgPts = series.filter((p) => isNum(p.wkg)).map((p) => [p.day, p.wkg]);

  const ftpB = bounds(ftpPts.map((p) => p[1]), 10, 5);
  const wkgB = wkgPts.length ? bounds(wkgPts.map((p) => p[1]), 0.05, 0.05) : null;
  const firstDay = ftpPts[0][0];
  const lastDay = [ftpPts.at(-1)[0], today].filter(Boolean).sort().at(-1);
  const spanDays = (dayTs(lastDay) - dayTs(firstDay)) / 86400000;

  const ftpColor = tokens.ftp;
  const wkgColor = tokens.weight;

  const out = [
    {
      name: 'FTP',
      type: 'line',
      step: 'end',
      data: ftpPts,
      showSymbol: false,
      symbol: 'none',
      z: 2,
      lineStyle: { width: 2.5, color: ftpColor },
      itemStyle: { color: ftpColor },
      areaStyle: { origin: 'start', color: fadeGradient(ftpColor, 0.25) },
    },
  ];
  if (wkgPts.length) {
    out.push({
      name: 'W/kg',
      type: 'line',
      yAxisIndex: 1,
      data: wkgPts,
      smooth: 0.3,
      smoothMonotone: 'x',
      showSymbol: false,
      symbol: 'none',
      z: 3,
      lineStyle: { width: 2, color: wkgColor },
      itemStyle: { color: wkgColor },
    });
  }
  out.push({
    name: 'tests',
    type: 'scatter',
    data: tests.map((t, i) =>
      i === tests.length - 1
        ? { value: [t.day, t.ftp_w], label: { show: true, position: 'top', distance: 8, formatter: `${fmtInt(t.ftp_w)} W`, color: tokens.ink2, fontSize: 11, fontWeight: 600 } }
        : [t.day, t.ftp_w]
    ),
    symbol: 'circle',
    symbolSize: 9,
    z: 4,
    itemStyle: { color: ftpColor, borderColor: tokens.card, borderWidth: 2 },
    emphasis: { scale: 1.3 },
  });

  const tooltip = axisTooltip(tokens, (params) => {
    const ps = Array.isArray(params) ? params : [params];
    if (!ps.length) return '';
    const head = `<div style="color:${tokens.ink2};margin-bottom:4px">${fmtTsDay(ps[0].axisValue)}</div>`;
    const rows = [];
    for (const p of ps) {
      const v = Array.isArray(p.value) ? p.value[1] : p.value;
      if (p.seriesName === 'FTP') rows.push(tipRow(p.marker, 'FTP', `${fmtInt(v)} W`));
      else if (p.seriesName === 'W/kg') rows.push(tipRow(p.marker, 'W/kg', v.toFixed(2)));
      else if (p.seriesName === 'tests') rows.push(tipRow(p.marker, 'Test', `${fmtInt(v)} W`));
    }
    return head + rows.join('');
  });

  const yAxis = [
    valueAxis(tokens, { ...ftpB, position: 'left', axisLabel: { formatter: (v) => `${v}` } }),
    valueAxis(tokens, {
      ...(wkgB || {}),
      position: 'right',
      splitLine: { show: false },
      axisLabel: { formatter: (v) => v.toFixed(2) },
    }),
  ];

  return {
    ...frame(tokens, opts),
    grid: grid({ top: 32, right: 4 }),
    legend: {
      show: true,
      top: 0,
      right: 0,
      data: wkgPts.length ? ['FTP', 'W/kg'] : ['FTP'],
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 4,
      itemGap: 14,
      selectedMode: false,
      textStyle: { color: tokens.ink2, fontSize: 11 },
    },
    tooltip,
    xAxis: timeAxis(tokens, { min: dayTs(firstDay), max: dayTs(lastDay), monthOnly: spanDays > 120 }),
    yAxis,
    series: out,
  };
}

// Card header hero: current W/kg with FTP watts.
export function ftpHero(data) {
  return cardStat('ftp', data);
}
