import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOAuthRouter } from './oauth.mjs';
import { registerReadTools } from './tools/read.mjs';
import { createWriteGuard } from './lib/write-guard.mjs';

export const SERVER_INSTRUCTIONS =
  'Food logging: the user tells you what they ate (text or photo). ' +
  '(1) Call `search_foods` for each distinct food, using the food name only, without quantities. ' +
  '(2) Prefer a favorite if one matches. Otherwise use a USDA match with a portion, otherwise your own estimate. ' +
  '(3) Call `log_food` once with all the items and WITHOUT `confirm` (it defaults to false); this writes nothing and returns the would-be rows and projected day totals. ' +
  '(4) Show the user a compact table: item, amount, kcal, P/C/F, confidence and source, plus the projected day total. ' +
  'Set `confidence` honestly: high = favorite, or a weighed or packaged label; med = USDA match with a portion stated in standard units; ' +
  'low = photo, vague portion, restaurant guess or mixed dish. Never present an estimate as exact. ' +
  '(5) Only after the user agrees, call `log_food` again with the same items and `confirm: true`. ' +
  'If something is eaten repeatedly, offer to `save_favorite`.';

export function createApp({ config, pool, writePool = null, registerTools = null }) {
  const guard = createWriteGuard(config);
  const { ALLOWED_HOST, MCP_API_KEY, OAUTH_STATE_PATH, ALLOWED_REDIRECT_URIS } = config;

  const ISSUER = `https://${ALLOWED_HOST}`;
  const RESOURCE = `https://${ALLOWED_HOST}/mcp`;
  const RESOURCE_METADATA_URL = `${ISSUER}/.well-known/oauth-protected-resource`;

  const { router: oauthRouter, validateAccessToken } = createOAuthRouter({
    issuer: ISSUER,
    resource: RESOURCE,
    apiKey: MCP_API_KEY,
    allowedRedirectUris: ALLOWED_REDIRECT_URIS.split(',').map((s) => s.trim()).filter(Boolean),
    statePath: OAUTH_STATE_PATH,
  });

  function getServer() {
    const server = new McpServer(
      { name: 'health-mcp', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
    );
    registerReadTools(server, { pool, config });
    if (registerTools) registerTools(server, { pool, writePool, config, guard });
    return server;
  }

  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const hostHeader = (req.get('host') || '').split(':')[0];
    if (hostHeader !== ALLOWED_HOST && hostHeader !== '127.0.0.1' && hostHeader !== 'localhost') {
      res.status(421).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Misdirected request' }, id: null });
      return;
    }
    next();
  });

  app.use(oauthRouter);

  function mcpAuth(req, res, next) {
    const auth = req.get('authorization') || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    // authInfo deliberately omits the bearer token so handlers cannot log it.
    if (provided && provided === MCP_API_KEY) {
      req.auth = { token: '', clientId: 'static_key', scopes: [] }; // static key path (Claude Code, curl, laptop)
      return next();
    }
    const entry = provided && validateAccessToken(provided);
    if (entry) {
      req.auth = { token: '', clientId: String(entry.client_id || 'oauth'), scopes: [] }; // OAuth access token path
      return next();
    }

    res.set('WWW-Authenticate', `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`);
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  }

  app.post('/mcp', mcpAuth, async (req, res) => {
    const server = getServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error('Error handling MCP request:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  });

  app.delete('/mcp', (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  });

  return app;
}
