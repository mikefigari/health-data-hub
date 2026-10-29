// Visual QA (local only, not CI): starts the dashboard in demo mode, drives the locally
// installed Microsoft Edge through playwright-core, screenshots every view at 1280 and 390 px
// in light and dark, and exits non-zero when a hard layout check fails.
// Run: cd dashboard && npm run test:visual
// PNGs land in <repo>/.claude/runs/dashboard-shots/ (gitignored).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../../src/app.mjs';
import { loadConfig } from '../../src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../../.claude/runs/dashboard-shots');
const TOKEN = crypto.randomBytes(30).toString('base64url'); // 40 chars of [A-Za-z0-9_-]

const VIEWS = ['all', 'today', 'weight', 'calories', 'protein', 'calendar', 'ftp'];
const THEMES = ['light', 'dark'];
const RANGES = [7, 30, 90, 365];
const SIZES = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];
// Single-panel views are Notion embeds of 460 px or less (A3). They stretch to fill their
// frame (min-height: 100vh), so they are rendered in a 460 px tall frame at each width.
const EMBED_HEIGHT = 460;
const ALL_MAX_HEIGHT_1280 = 1800;
const DARK_BG = 'rgb(25, 25, 25)'; // #191919
const CALENDAR_MIN_HEIGHT = 80;

const failures = [];
const fail = (name, msg) => failures.push(`${name}: ${msg}`);
// Never print the token or query strings.
const redact = (url) => {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/d\/[^/]*/, '/d/[token]');
  } catch {
    return '[unparseable url]';
  }
};

async function startServer() {
  const config = loadConfig({ DASHBOARD_TOKENS: TOKEN, DASHBOARD_DEMO: 'true' });
  const app = createApp({ config, pool: null, log: () => {} });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Layout facts gathered in the page. Every chart needs a canvas larger than 100x100, except
// the logging calendar: a 7-row strip of 27 week columns whose cell size is capped by the T7
// spec (27 * (cell + 2 px gap) must fit the width), so on a 326 px phone card it is ~89 px
// tall by design. It must still be wider than 100 px and at least 80 px tall (7 legible rows).
function measure(calendarMinHeight) {
  const de = document.documentElement;
  const cards = [...document.querySelectorAll('.card')]
    .filter((c) => c.scrollWidth > c.clientWidth)
    .map((c) => `${c.className} (${c.scrollWidth} > ${c.clientWidth})`);
  const charts = [...document.querySelectorAll('.chart')]
    .filter((node) => {
      const calendar = node.dataset.chart === 'calendar';
      return ![...node.querySelectorAll('canvas')].some((cv) => {
        const r = cv.getBoundingClientRect();
        return r.width > 100 && (calendar ? r.height >= calendarMinHeight : r.height > 100);
      });
    })
    .map((node) => node.dataset.chart || node.className);
  return {
    scrollWidth: de.scrollWidth,
    innerWidth: window.innerWidth,
    scrollHeight: de.scrollHeight,
    cards,
    charts,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    csp: window.__cspViolations || [],
  };
}

// True when the ECharts HTML tooltip inside the calories chart is showing.
function tooltipVisible() {
  const node = document.querySelector('.chart[data-chart="calories"]');
  if (!node) return false;
  return [...node.querySelectorAll('div')].some((d) => {
    const cs = getComputedStyle(d);
    const r = d.getBoundingClientRect();
    return (
      cs.zIndex === '9999999' &&
      cs.display !== 'none' &&
      cs.visibility === 'visible' &&
      Number(cs.opacity) > 0.5 &&
      r.width > 20 &&
      r.height > 20 &&
      d.textContent.trim().length > 0
    );
  });
}

async function shoot(context, { view, width, theme, range }) {
  const name = `${view}-${width}-${theme}${range ? `-${range}` : ''}`;
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(`console error: ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => errors.push(`page error: ${String(e.message).slice(0, 200)}`));
  page.on('requestfailed', (r) => errors.push(`request failed: ${redact(r.url())} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()}: ${redact(r.url())}`));

  const single = view !== 'all';
  const height = single ? EMBED_HEIGHT : SIZES.find((s) => s.width === width).height;
  await page.setViewportSize({ width, height });

  const q = new URLSearchParams({ theme });
  if (single) q.set('view', view);
  if (range) q.set('range', String(range));
  const res = await page.goto(`/d/${TOKEN}?${q}`, { waitUntil: 'load' });
  if (!res || res.status() !== 200) fail(name, `shell status ${res?.status()}`);
  else if (!/script-src 'self'/.test(res.headers()['content-security-policy'] || '')) fail(name, 'CSP header missing');

  try {
    await page.waitForFunction(
      () => {
        const app = document.getElementById('app');
        return !app.hasAttribute('aria-busy') && app.querySelector('.card') && !app.querySelector('.is-loading');
      },
      null,
      { timeout: 15000 }
    );
  } catch {
    fail(name, 'dashboard never finished loading');
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const m = await page.evaluate(measure, CALENDAR_MIN_HEIGHT);
  if (m.scrollWidth > m.innerWidth) fail(name, `horizontal overflow (scrollWidth ${m.scrollWidth} > ${m.innerWidth})`);
  for (const c of m.cards) fail(name, `card overflows: ${c}`);
  for (const c of m.charts) fail(name, `chart without a canvas larger than 100x100: ${c}`);
  if (single && m.scrollHeight > EMBED_HEIGHT) fail(name, `single view scrollHeight ${m.scrollHeight} > ${EMBED_HEIGHT}`);
  if (view === 'all' && width === 1280 && m.scrollHeight > ALL_MAX_HEIGHT_1280) {
    fail(name, `all view scrollHeight ${m.scrollHeight} > ${ALL_MAX_HEIGHT_1280}`);
  }
  if (theme === 'dark' && m.bodyBg !== DARK_BG) fail(name, `dark body background ${m.bodyBg}, expected ${DARK_BG}`);
  for (const v of m.csp) fail(name, `CSP violation: ${v}`);

  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });

  // Phones: a tap in the middle of the calories chart must open its tooltip.
  if (width === 390 && (view === 'calories' || view === 'all')) {
    const chart = page.locator('.chart[data-chart="calories"]');
    if ((await chart.count()) === 0) {
      fail(name, 'calories chart missing for tap test');
    } else {
      await chart.scrollIntoViewIfNeeded();
      const box = await chart.boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      try {
        await page.waitForFunction(tooltipVisible, null, { timeout: 2000 });
      } catch {
        fail(name, 'tap on the calories chart did not show a visible tooltip');
      }
    }
  }

  for (const e of errors) fail(name, e);
  await page.close();
  return name;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, base } = await startServer();
  let browser;
  let shots = 0;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    for (const size of SIZES) {
      for (const theme of THEMES) {
        const context = await browser.newContext({
          baseURL: base,
          viewport: size,
          deviceScaleFactor: 2,
          hasTouch: size.width === 390,
          // Opposite system preference, so ?theme=<name> is what sets the theme.
          colorScheme: theme === 'dark' ? 'light' : 'dark',
          reducedMotion: 'reduce',
        });
        await context.addInitScript(() => {
          window.__cspViolations = [];
          document.addEventListener('securitypolicyviolation', (e) => {
            window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI ? new URL(e.blockedURI, location.href).pathname : ''}`);
          });
        });
        const jobs = VIEWS.map((view) => ({ view, width: size.width, theme }));
        if (size.width === 1280 && theme === 'light') {
          for (const range of RANGES) jobs.push({ view: 'all', width: 1280, theme, range });
        }
        for (const job of jobs) {
          await shoot(context, job);
          shots += 1;
        }
        await context.close();
      }
    }
  } catch (err) {
    failures.push(`run aborted: ${String(err?.message ?? err).split('\n')[0]}`);
  } finally {
    await browser?.close();
    server.close();
  }

  console.log(`visual QA: ${shots} screenshots in ${path.relative(process.cwd(), OUT)}`);
  if (failures.length) {
    console.error(`visual QA: ${failures.length} failure(s)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('visual QA: all checks passed');
}

main();
