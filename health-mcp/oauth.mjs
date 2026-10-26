import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';

// Minimal OAuth 2.1 authorization server, co-located with the MCP resource
// server, sized for a single user (this Pi's owner). "Login" is knowing the
// existing MCP_API_KEY — there is only one identity, and it maps 1:1 to the
// claude_readonly Postgres role the MCP server already connects as.
export function createOAuthRouter({ issuer, resource, apiKey, allowedRedirectUris, statePath }) {
  const router = express.Router();

  let state = { clients: {}, tokens: {}, refreshTokens: {} };
  function load() {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      // first run, no state file yet
    }
  }
  function save() {
    fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  }
  load();

  const pendingAuth = new Map(); // reqId -> pending authorize() request, short-lived
  const codes = new Map(); // authorization code -> grant, short-lived

  const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
  const sha256base64url = (input) => crypto.createHash('sha256').update(input).digest('base64url');

  function pruneExpired() {
    const now = Date.now();
    for (const [tok, v] of Object.entries(state.tokens)) {
      if (v.expiresAt < now) delete state.tokens[tok];
    }
    for (const [id, v] of pendingAuth) {
      if (v.expiresAt < now) pendingAuth.delete(id);
    }
    for (const [c, v] of codes) {
      if (v.expiresAt < now) codes.delete(c);
    }
  }

  // RFC 9728 — Protected Resource Metadata
  router.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });
  });

  // RFC 8414 — Authorization Server Metadata
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  // RFC 7591 — Dynamic Client Registration. Public endpoint (no auth) per spec;
  // the redirect_uri allowlist below is what actually protects this.
  router.post('/register', express.json(), (req, res) => {
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirectUris.length === 0) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    }
    const disallowed = redirectUris.filter((u) => !allowedRedirectUris.includes(u));
    if (disallowed.length > 0) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: `Redirect URI not allowed: ${disallowed[0]}`,
      });
    }
    const clientId = randomToken(16);
    state.clients[clientId] = {
      client_id: clientId,
      redirect_uris: redirectUris,
      client_name: body.client_name || null,
      created_at: Date.now(),
    };
    save();
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(body.client_name ? { client_name: body.client_name } : {}),
    });
  });

  // Authorization endpoint — renders a one-field "enter your access key" page.
  router.get('/authorize', (req, res) => {
    pruneExpired();
    const { client_id, redirect_uri, response_type, state: clientState, code_challenge, code_challenge_method, resource: reqResource } = req.query;

    const client = state.clients[client_id];
    if (!client) return res.status(400).send('Unknown client_id. Register first via /register.');
    if (!client.redirect_uris.includes(redirect_uri)) return res.status(400).send('redirect_uri does not match registered value.');
    if (response_type !== 'code') return res.status(400).send('Only response_type=code is supported.');
    if (!code_challenge || code_challenge_method !== 'S256') return res.status(400).send('PKCE with S256 is required.');

    const reqId = randomToken(16);
    pendingAuth.set(reqId, {
      client_id,
      redirect_uri,
      clientState: clientState || null,
      code_challenge,
      resource: reqResource || resource,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 16px">
<h2>Authorize health-mcp</h2>
<p>${client.client_name ? escapeHtml(client.client_name) : 'This application'} is requesting access to read your health data and log food.</p>
<form method="POST" action="/authorize/approve">
  <input type="hidden" name="req" value="${reqId}">
  <input type="password" name="key" placeholder="Access key" style="width:100%;padding:10px;font-size:16px;box-sizing:border-box" autofocus required>
  <button type="submit" style="margin-top:12px;padding:10px 20px;font-size:16px">Authorize</button>
</form>
</body></html>`);
  });

  router.post('/authorize/approve', express.urlencoded({ extended: false }), (req, res) => {
    pruneExpired();
    const { req: reqId, key } = req.body;
    const pending = pendingAuth.get(reqId);
    if (!pending) return res.status(400).send('This authorization request expired. Go back and try again.');
    pendingAuth.delete(reqId);

    if (key !== apiKey) {
      return res.status(401).send('Incorrect access key.');
    }

    const code = randomToken(32);
    codes.set(code, {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      resource: pending.resource,
      expiresAt: Date.now() + 60 * 1000,
    });

    const url = new URL(pending.redirect_uri);
    url.searchParams.set('code', code);
    if (pending.clientState) url.searchParams.set('state', pending.clientState);
    res.redirect(url.toString());
  });

  // RFC 6749 token endpoint (authorization_code + refresh_token grants)
  router.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    pruneExpired();
    const { grant_type } = req.body;

    if (grant_type === 'authorization_code') {
      const { code, redirect_uri, code_verifier, client_id } = req.body;
      const entry = codes.get(code);
      if (!entry) return res.status(400).json({ error: 'invalid_grant' });
      codes.delete(code); // single use, regardless of outcome

      if (entry.redirect_uri !== redirect_uri || entry.client_id !== client_id) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      if (!code_verifier || sha256base64url(code_verifier) !== entry.code_challenge) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }

      const accessToken = randomToken(32);
      const refreshToken = randomToken(32);
      const expiresIn = 3600;
      state.tokens[accessToken] = { client_id, resource: entry.resource, expiresAt: Date.now() + expiresIn * 1000 };
      state.refreshTokens[refreshToken] = { client_id, resource: entry.resource };
      save();
      return res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: refreshToken,
        scope: 'mcp',
      });
    }

    if (grant_type === 'refresh_token') {
      const { refresh_token, client_id } = req.body;
      const entry = state.refreshTokens[refresh_token];
      if (!entry || entry.client_id !== client_id) return res.status(400).json({ error: 'invalid_grant' });

      const accessToken = randomToken(32);
      const expiresIn = 3600;
      state.tokens[accessToken] = { client_id, resource: entry.resource, expiresAt: Date.now() + expiresIn * 1000 };
      save();
      return res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, scope: 'mcp' });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

  function validateAccessToken(token) {
    pruneExpired();
    const entry = state.tokens[token];
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) return null;
    if (entry.resource !== resource) return null;
    return entry;
  }

  return { router, validateAccessToken };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
