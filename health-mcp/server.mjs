import express from 'express';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOAuthRouter } from './oauth.mjs';

const {
  PORT = '8877',
  DB_HOST = 'localhost',
  DB_PORT = '5432',
  DB_NAME = 'health_pi',
  DB_USER = 'claude_readonly',
  DB_PASSWORD,
  MCP_API_KEY,
  QUERY_TIMEOUT_MS = '10000',
  MAX_ROWS = '1000',
  ALLOWED_HOST = 'health-mcp.michaelfigari.com',
  OAUTH_STATE_PATH = '/home/mike/.config/health-mcp/oauth-state.json',
  ALLOWED_REDIRECT_URIS = 'https://claude.ai/api/mcp/auth_callback',
} = process.env;

if (!DB_PASSWORD) {
  console.error('DB_PASSWORD is not set. Exiting.');
  process.exit(1);
}
if (!MCP_API_KEY || MCP_API_KEY.length < 32) {
  console.error('MCP_API_KEY must be set and at least 32 characters. Exiting.');
  process.exit(1);
}

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

const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
  statement_timeout: Number(QUERY_TIMEOUT_MS),
});

// Belt-and-suspenders: reject anything that isn't a single read-only statement,
// even though the DB role itself is already SELECT-only / read-only-transaction.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|reindex|refresh|call|do|merge|comment|listen|notify|prepare|execute)\b/i;

function assertReadOnlySql(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    throw new Error('Only a single statement is allowed.');
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Only SELECT (or WITH ... SELECT) statements are allowed.');
  }
  if (FORBIDDEN.test(trimmed)) {
    throw new Error('Statement contains a disallowed keyword.');
  }
  return trimmed;
}

function getServer() {
  const server = new McpServer(
    { name: 'health-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description: 'List tables and views in the health_pi database (public schema), with approximate row counts.',
      inputSchema: {},
    },
    async () => {
      const { rows } = await pool.query(`
        SELECT c.relname AS name,
               CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind,
               COALESCE(s.n_live_tup, 0) AS approx_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v')
        ORDER BY name;
      `);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description: 'Show column names, types, and nullability for a table or view in the public schema.',
      inputSchema: { table: z.string().describe('Table or view name (public schema)') },
    },
    async ({ table }) => {
      const { rows } = await pool.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position;`,
        [table]
      );
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `No such table/view: ${table}` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    'query',
    {
      title: 'Read-only SQL query',
      description:
        `Run a single read-only SQL SELECT statement against the health_pi database and return the rows. ` +
        `Results are capped at ${MAX_ROWS} rows. Writes and multi-statement input are rejected.`,
      inputSchema: { sql: z.string().describe('A single SELECT statement') },
    },
    async ({ sql }) => {
      let safeSql;
      try {
        safeSql = assertReadOnlySql(sql);
      } catch (err) {
        return { content: [{ type: 'text', text: `Rejected: ${err.message}` }], isError: true };
      }
      const wrapped = `SELECT * FROM (${safeSql}) AS _q LIMIT ${Number(MAX_ROWS)}`;
      try {
        const { rows } = await pool.query(wrapped);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Query error: ${err.message}` }], isError: true };
      }
    }
  );

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

app.listen(Number(PORT), '127.0.0.1', () => {
  console.log(`health-mcp listening on 127.0.0.1:${PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
