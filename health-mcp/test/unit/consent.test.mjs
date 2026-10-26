// T12 spec: OAuth consent text. No database, no network: the OAuth router is
// mounted on a bare express app served on 127.0.0.1 with an ephemeral port and
// a throwaway state file in the OS temp directory.
//
// Module interface assumed (unchanged from today):
//   oauth.mjs  createOAuthRouter({ issuer, resource, apiKey, allowedRedirectUris,
//              statePath }) -> { router, validateAccessToken }; router serves
//              POST /register and GET /authorize.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

import { createOAuthRouter } from '../../oauth.mjs';

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const CHALLENGE = crypto.createHash('sha256').update('v'.repeat(64)).digest('base64url');

describe('OAuth consent page', () => {
  let server;
  let base;
  let statePath;
  let clientId;

  before(async () => {
    statePath = path.join(os.tmpdir(), `health-mcp-t12-${crypto.randomUUID()}.json`);
    const app = express();
    const { router } = createOAuthRouter({
      issuer: 'http://127.0.0.1',
      resource: 'http://127.0.0.1/mcp',
      apiKey: 'k'.repeat(40),
      allowedRedirectUris: [REDIRECT_URI],
      statePath,
    });
    app.use(router);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;

    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: 'Claude' }),
    });
    assert.equal(reg.status, 201);
    clientId = (await reg.json()).client_id;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.unlinkSync(statePath);
    } catch {
      // state file may not exist
    }
  });

  function authorizeUrl(overrides = {}) {
    const params = {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      state: 'xyz',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      ...overrides,
    };
    const url = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  test('(a) consent page for a registered client says it can log food, not read-only', async () => {
    const res = await fetch(authorizeUrl());
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /is requesting access to read your health data and log food/);
    assert.ok(html.includes('log food'));
    assert.ok(!html.includes('read-only access'), 'consent page must not claim read-only access');
  });

  test('(b) missing code_challenge is still rejected with 400', async () => {
    const res = await fetch(authorizeUrl({ code_challenge: undefined }));
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.ok(!body.includes('log food'), 'no consent page is rendered without PKCE');
  });

  test('(b) unregistered redirect_uri is still rejected with 400', async () => {
    const res = await fetch(authorizeUrl({ redirect_uri: 'https://evil.example/cb' }));
    assert.equal(res.status, 400);
  });
});
