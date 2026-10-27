import crypto from 'node:crypto';
import express from 'express';

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

const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Health Dashboard</title></head>
<body><main id="app">Dashboard loading</main></body></html>
`;

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
  app.get('/api/dashboard', (req, res) => res.status(501).json({ error: 'not implemented' }));

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
