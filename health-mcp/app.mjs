import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOAuthRouter } from './oauth.mjs';
import { registerReadTools } from './tools/read.mjs';

export function createApp({ config, pool }) {
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
      { capabilities: { tools: {} } }
    );
    registerReadTools(server, { pool, config });
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

    if (provided && provided === MCP_API_KEY) return next(); // static key path (Claude Code, curl, laptop)
    if (provided && validateAccessToken(provided)) return next(); // OAuth access token path (claude.ai web/mobile)

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
