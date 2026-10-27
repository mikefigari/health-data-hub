// DOM wiring: fetch /api/dashboard, render the shell, mount charts, handle resize/theme/refresh.
// All pure logic lives in core.mjs (unit-tested); this file is browser-only.
import {
  TOKENS,
  RANGES,
  RANGE_LABELS,
  REFRESH_MS,
  parseParams,
  tokenFromPath,
  apiQuery,
  cardsFor,
  kpis,
  cardStat,
  emptyMessage,
  fmtDay,
  fmtLongDay,
  fmtTime,
} from './core.mjs';
import { ringOption, ringLabel } from './charts/rings.mjs';
import { weightOption, weightHero } from './charts/weight.mjs';
import { ftpOption, ftpHero } from './charts/ftp.mjs';
import { caloriesOption, caloriesSubtitle, proteinOption, proteinHero } from './charts/nutrition.mjs';
import { calendarOption, calendarHeight, calendarLegend } from './charts/calendar.mjs';

// Chart option builders, keyed by a chart node's data-chart attribute:
// (data, ctx) => ECharts option, or { empty: message } when there is nothing to draw.
// ctx = { tokens, reducedMotion, theme, range, view, width }.
// Calorie ring fills toward a goal; the protein ring fills toward the top of its % band (D12).
const RINGS = [
  {
    key: 'calories',
    title: 'Calories',
    unit: 'kcal',
    data: (t) => ({ value: t.calories, goal: t.goal_calories }),
  },
  {
    key: 'protein',
    title: 'Protein',
    unit: '%',
    data: (t, g) => ({ value: t.protein_pct, min: g.protein_pct_min, max: g.protein_pct_max }),
  },
];
const ringData = (data, r) => r.data(data?.today_rings || {}, data?.goals || {});
const BUILDERS = {
  'today:calories': (data, ctx) => ringOption(ringData(data, RINGS[0]), ctx.tokens, { ...ctx, accent: 'calories' }),
  'today:protein': (data, ctx) => ringOption(ringData(data, RINGS[1]), ctx.tokens, { ...ctx, accent: 'protein' }),
  weight: (data, ctx) => weightOption(data, ctx.tokens, ctx),
  calories: (data, ctx) => caloriesOption(data, ctx.tokens, ctx),
  protein: (data, ctx) => proteinOption(data, ctx.tokens, ctx),
  calendar: (data, ctx) => calendarOption(data, ctx.tokens, ctx),
  ftp: (data, ctx) => ftpOption(data, ctx.tokens, ctx),
};
// Card header hero numbers; other cards use core cardStat().
const HEROES = { weight: weightHero, ftp: ftpHero, protein: proteinHero };
// Optional second caption line under a card's hero.
const SUBTITLES = { calories: (data) => caloriesSubtitle(data, { range: state.range }) };
// Calendar legend swatches use CSS custom properties so they follow the theme without a re-render.
const LEGEND_VAR = { under: '--calories', over: '--over', none: '--track' };
// Charts whose layout depends on their pixel width (rebuilt on resize).
const WIDTH_AWARE = new Set(['calendar']);

const root = document.documentElement;
const app = document.getElementById('app');
const params = parseParams(location.search);
const token = tokenFromPath(location.pathname);
const single = params.view !== 'all';
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  range: params.range,
  data: null,
  demo: params.demo,
  fetchedAt: null,
  loading: false,
  refreshFailed: false,
  charts: new Map(), // view -> echarts instance
  seq: 0,
};

if (params.theme) root.dataset.theme = params.theme;
root.classList.toggle('single', single);

const theme = () => params.theme || (darkMq.matches ? 'dark' : 'light');
const ctxFor = (view, node) => ({
  tokens: TOKENS[theme()],
  reducedMotion: motionMq.matches,
  theme: theme(),
  range: state.range,
  view,
  width: node?.clientWidth || undefined,
});

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

// ---- Range toggle ----
function rangeToggle() {
  return el(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Date range' },
    RANGES.map((r) =>
      el('button', {
        type: 'button',
        class: 'seg-btn',
        'aria-pressed': String(r === state.range),
        text: RANGE_LABELS[r],
        onclick: () => setRange(r),
      })
    )
  );
}

function setRange(r) {
  if (r === state.range || state.loading) return;
  state.range = r;
  const q = new URLSearchParams(location.search);
  q.set('range', String(r));
  history.replaceState(null, '', `${location.pathname}?${q}`);
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.setAttribute('aria-pressed', String(b.textContent === RANGE_LABELS[r]));
  }
  load({ keepContent: true });
}

// ---- Full-page states ----
// Dispose each chart and unobserve its node together, so ResizeObserver entries never leak.
function disposeCharts() {
  for (const { chart, node } of state.charts.values()) {
    resizeObserver?.unobserve(node);
    chart.dispose();
  }
  state.charts.clear();
}

function renderInvalid() {
  stopRefresh();
  disposeCharts();
  app.replaceChildren(el('div', { class: 'state state--invalid' }, el('p', { class: 'state-title', text: 'This link is no longer valid' })));
  app.removeAttribute('aria-busy');
}

function renderError() {
  disposeCharts();
  app.replaceChildren(
    el(
      'div',
      { class: 'state', role: 'alert' },
      el('p', { class: 'state-title', text: 'Can’t load your dashboard' }),
      el('p', { class: 'state-caption', text: 'Check your connection and try again.' }),
      el('button', { type: 'button', class: 'btn', text: 'Retry', onclick: () => load() })
    )
  );
  app.removeAttribute('aria-busy');
}

function renderSkeleton() {
  disposeCharts();
  const cards = cardsFor(params.view).map((c) =>
    el(
      'section',
      { class: `card card--${c.view} is-loading`, 'aria-hidden': 'true' },
      el('div', { class: 'sk sk--label' }),
      el('div', { class: 'sk sk--value' }),
      el('div', { class: 'sk sk--chart' })
    )
  );
  const parts = [];
  if (!single) {
    parts.push(
      el(
        'header',
        { class: 'page-header' },
        el('div', { class: 'title-row' }, el('div', {}, el('div', { class: 'sk sk--label' }), el('h1', { text: 'Summary' }))),
        el('div', { class: 'kpis' }, [0, 1, 2, 3].map(() => el('div', { class: 'kpi is-loading' }, el('div', { class: 'sk sk--label' }), el('div', { class: 'sk sk--value' }))))
      )
    );
  }
  parts.push(el('main', { class: 'grid' }, cards));
  app.replaceChildren(...parts);
  app.setAttribute('aria-busy', 'true');
}

// ---- Dashboard ----
function kpiTile(k) {
  return el(
    'div',
    { class: 'kpi' },
    el('div', { class: 'label' }, el('span', { class: `dot dot--${k.accent}`, 'aria-hidden': 'true' }), k.label),
    el('div', { class: 'stat' }, el('span', { class: 'value num', text: k.value }), k.unit ? el('span', { class: 'unit', text: k.unit }) : null),
    el('div', { class: 'caption', text: k.caption })
  );
}

// Today card: two rings side by side, each with an HTML center label.
function ringsBody(data) {
  return el(
    'div',
    { class: 'rings' },
    RINGS.map((r) => {
      const d = ringData(data, r);
      const label = ringLabel(d, { unit: r.unit });
      return el(
        'figure',
        { class: `ring ring--${r.key}` },
        el(
          'div',
          { class: 'ring-plot' },
          el('div', { class: 'chart chart--ring', 'data-chart': `today:${r.key}`, role: 'img', 'aria-label': `${r.title}: ${label.big} ${label.small}, ${label.caption}` }),
          el(
            'div',
            { class: 'ring-center', 'aria-hidden': 'true' },
            el('span', { class: 'ring-big num', text: label.big }),
            el('span', { class: 'ring-small', text: label.small })
          )
        ),
        el(
          'figcaption',
          { class: 'ring-caption' },
          el('span', { class: `dot dot--${r.key}`, 'aria-hidden': 'true' }),
          `${r.title} · ${label.caption}`
        )
      );
    })
  );
}

function calendarLegendEl() {
  return el(
    'div',
    { class: 'caption', style: 'display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:10px' },
    calendarLegend(TOKENS[theme()]).map((l) =>
      el(
        'span',
        { style: 'display:inline-flex;align-items:center;gap:6px' },
        el('span', { class: 'dot', 'aria-hidden': 'true', style: `background:var(${LEGEND_VAR[l.key]})` }),
        l.label
      )
    )
  );
}

function card(c, data) {
  const stat = (HEROES[c.view] || ((d) => cardStat(c.view, d)))(data);
  const subtitle = SUBTITLES[c.view]?.(data);
  const empty = emptyMessage(c.view, data);
  const head = el(
    'div',
    { class: 'card-head' },
    el('h2', { class: 'label' }, el('span', { class: `dot dot--${c.accent}`, 'aria-hidden': 'true' }), c.title),
    single && c.ranged ? rangeToggle() : null
  );
  const body = empty
    ? el('div', { class: 'empty', text: empty })
    : c.view === 'today'
      ? ringsBody(data)
      : el('div', { class: 'chart', 'data-chart': c.view, role: 'img', 'aria-label': `${c.title} chart` });
  const legend = !empty && c.view === 'calendar' ? calendarLegendEl() : null;
  return el(
    'section',
    { class: `card card--${c.view}`, 'aria-label': c.title },
    head,
    el('div', { class: 'stat' }, el('span', { class: 'value num', text: stat.value }), stat.unit ? el('span', { class: 'unit', text: stat.unit }) : null),
    stat.caption ? el('div', { class: 'caption', text: stat.caption }) : null,
    subtitle ? el('div', { class: 'caption', text: subtitle }) : null,
    body,
    legend
  );
}

function footer(data) {
  const text = `Updated ${fmtTime(state.fetchedAt)} · data through ${fmtDay(data.today)}`;
  return el(
    'footer',
    { class: 'footer' },
    el('span', { text }),
    state.demo ? el('span', { class: 'pill', text: 'Demo data' }) : null,
    state.refreshFailed
      ? el('button', { type: 'button', class: 'link-btn', text: 'Couldn’t refresh · Retry', onclick: () => load({ keepContent: true }) })
      : null
  );
}

function renderDashboard() {
  const data = state.data;
  disposeCharts();
  const parts = [];
  if (!single) {
    parts.push(
      el(
        'header',
        { class: 'page-header' },
        el(
          'div',
          { class: 'title-row' },
          el('div', {}, el('p', { class: 'eyebrow', text: fmtLongDay(data.today) }), el('h1', { text: 'Summary' })),
          rangeToggle()
        ),
        el('section', { class: 'kpis', 'aria-label': 'Highlights' }, kpis(data).map(kpiTile))
      )
    );
  }
  parts.push(el('main', { class: 'grid' }, cardsFor(params.view).map((c) => card(c, data))));
  parts.push(footer(data));
  app.replaceChildren(...parts);
  app.removeAttribute('aria-busy');
  mountCharts();
}

// ---- Charts ----
let resizeObserver = null;

function mountCharts() {
  const echarts = window.echarts;
  if (echarts && !resizeObserver && 'ResizeObserver' in window) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) {
        const key = e.target.dataset.chart;
        const entry = state.charts.get(key);
        if (!entry) continue;
        if (WIDTH_AWARE.has(key)) rebuildChart(key, entry);
        entry.chart.resize();
      }
    });
  }
  for (const node of app.querySelectorAll('.chart[data-chart]')) {
    const key = node.dataset.chart;
    const build = BUILDERS[key];
    if (!build) continue;
    sizeNode(key, node);
    const option = build(state.data, ctxFor(key.split(':')[0], node));
    if (option?.empty) {
      node.replaceWith(el('div', { class: 'empty', text: option.empty }));
      continue;
    }
    if (!echarts) continue;
    const chart = echarts.init(node, null, { renderer: 'canvas' });
    chart.setOption(option, true);
    if (WIDTH_AWARE.has(key)) node.dataset.width = String(node.clientWidth);
    state.charts.set(key, { chart, node });
    resizeObserver?.observe(node);
  }
}

// The calendar's height follows its cell size, which follows its width.
function sizeNode(key, node) {
  if (key === 'calendar' && node.clientWidth) node.style.height = `${calendarHeight(node.clientWidth)}px`;
}

function rebuildChart(key, { chart, node }) {
  const width = node.clientWidth;
  if (WIDTH_AWARE.has(key)) {
    if (node.dataset.width === String(width)) return;
    node.dataset.width = String(width);
    sizeNode(key, node);
  }
  const option = BUILDERS[key](state.data, ctxFor(key.split(':')[0], node));
  if (!option?.empty) chart.setOption(option, true);
}

function restyleCharts() {
  if (!state.data) return;
  for (const [key, entry] of state.charts) {
    delete entry.node.dataset.width;
    rebuildChart(key, entry);
  }
}

// ---- Fetch ----
async function load({ keepContent = false } = {}) {
  if (!token) return renderInvalid();
  const seq = ++state.seq;
  state.loading = true;
  if (!keepContent || !state.data) renderSkeleton();
  else app.setAttribute('aria-busy', 'true');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(`/api/dashboard${apiQuery({ range: state.range, demo: params.demo })}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      credentials: 'omit',
      signal: ac.signal,
    });
    if (seq !== state.seq) return;
    if (res.status === 401) return renderInvalid();
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    if (seq !== state.seq) return;
    state.data = data;
    state.demo = params.demo || res.headers.get('x-dashboard-demo') === '1';
    state.fetchedAt = new Date();
    state.refreshFailed = false;
    renderDashboard();
  } catch {
    if (seq !== state.seq) return;
    if (keepContent && state.data) {
      state.refreshFailed = true;
      renderDashboard();
    } else {
      renderError();
    }
  } finally {
    clearTimeout(timer);
    if (seq === state.seq) state.loading = false;
  }
}

// ---- Refresh every 15 min while visible ----
let refreshTimer = null;
function startRefresh() {
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') load({ keepContent: true });
  }, REFRESH_MS);
}
function stopRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = null;
}
document.addEventListener('visibilitychange', () => {
  if (!refreshTimer || document.visibilityState !== 'visible' || !state.fetchedAt) return;
  if (Date.now() - state.fetchedAt.getTime() >= REFRESH_MS) load({ keepContent: true });
});

darkMq.addEventListener?.('change', restyleCharts);
motionMq.addEventListener?.('change', restyleCharts);
if (!('ResizeObserver' in window)) {
  window.addEventListener('resize', () =>
    state.charts.forEach((entry, key) => {
      if (WIDTH_AWARE.has(key)) rebuildChart(key, entry);
      entry.chart.resize();
    })
  );
}

startRefresh();
load();
