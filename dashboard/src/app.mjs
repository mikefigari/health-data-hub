import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildDashboard } from './aggregate.mjs';
import { demoInputs } from './demo.mjs';
import { fetchInputs } from './queries.mjs';

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

// Constant-time comparison over SHA-256 digests (equal length, so no length leak).
export function tokenMatches(candidate, tokens) {
  const digest = sha256(candidate ?? '');
  let ok = false;
  for (const t of tokens) {
    if (crypto.timingSafeEqual(digest, sha256(t))) ok = true;
  }
  return ok;
}

function redactPath(url) {
  const path = String(url).split('?')[0];
  return path.replace(/^\/d\/[^/]*/i, '/d/[redacted]');
}

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const ECHARTS_JS = fileURLToPath(new URL('../node_modules/echarts/dist/echarts.min.js', import.meta.url));
const SHELL = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const ASSET_OPTS = { maxAge: 3600 * 1000, index: false, dotfiles: 'ignore', fallthrough: true };

export function createApp({ config, pool, now = () => new Date(), log = console.log }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.locals.pool = pool;
  app.locals.now = now;

  const csp = [
    `frame-ancestors ${config.FRAME_ANCESTORS}`,
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');

  // Security headers + access log on every response. No X-Frame-Options: it
  // cannot express a Notion allow-list and would block the embed.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.set({
      'Content-Security-Policy': csp,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    const lower = req.path.toLowerCase();
    if (lower.startsWith('/d/') || lower.startsWith('/api/')) {
      res.set('Cache-Control', 'no-store');
    }
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log(`${req.method} ${redactPath(req.originalUrl)} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  app.get('/healthz', (req, res) => res.status(200).type('text/plain').send('ok'));

  // Static assets: 'self' only, 1 h public cache (no tokens or data in these files).
  app.get('/assets/vendor/echarts.min.js', (req, res, next) => res.sendFile(ECHARTS_JS, ASSET_OPTS, (e) => e && next()));
  app.use('/assets', express.static(PUBLIC_DIR, ASSET_OPTS));

  app.get(['/d/:token', '/d/:token/'], (req, res) => {
    if (!tokenMatches(req.params.token, config.TOKENS)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    res.status(200).type('html').send(SHELL);
  });

  const apiGuard = (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m || !tokenMatches(m[1], config.TOKENS)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
  app.use('/api', apiGuard);

  const CACHE_MS = 60_000;
  const RANGES = new Set(['7', '30', '90', '365']);
  const cache = new Map();
  const laToday = () =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now());

  app.get('/api/dashboard', async (req, res) => {
    const rawRange = req.query.range === undefined ? '30' : req.query.range;
    if (typeof rawRange !== 'string' || !RANGES.has(rawRange)) {
      return res.status(400).json({ error: 'bad_range' });
    }
    const rangeDays = Number(rawRange);
    const demo = config.DEMO || req.query.demo === '1';
    if (demo) res.set('X-Dashboard-Demo', '1'); // lets the page show the "Demo data" pill in env demo mode
    const key = `${rangeDays}|${demo}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.status(200).json(hit.body);
    try {
      let inputs;
      if (demo) {
        const today = laToday();
        inputs = { ...demoInputs(today), today };
      } else {
        inputs = await fetchInputs(pool);
      }
      const body = buildDashboard({
        ...inputs,
        rangeDays, planKgPerWeek: config.PLAN_KG_PER_WEEK, maintenanceKcal: config.MAINTENANCE_KCAL,
        proteinPctMin: config.PROTEIN_PCT_MIN,
        proteinPctMax: config.PROTEIN_PCT_MAX,
      });
      cache.set(key, { at: Date.now(), body });
      return res.status(200).json(body);
    } catch (err) {
      // Code and message only: never rows, params or query text.
      log(`error code=${err?.code ?? 'none'} message=${String(err?.message ?? '')}`);
      return res.status(503).json({ error: 'unavailable' });
    }
  });

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  // Final error handler: never leak stacks or raw params (they can hold a token).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err && (err.status || err.statusCode);
    const client = status >= 400 && status < 500;
    log(`error code=${err?.code ?? 'none'} message=${client ? 'client error' : String(err?.message ?? '')}`);
    if (res.headersSent) return res.end();
    if (client) return res.status(status === 400 ? 400 : 404).type('text/plain').send('Not found');
    res.status(500).type('text/plain').send('Internal error');
  });
  return app;
}
