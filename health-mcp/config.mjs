// Reads and validates configuration from an env-like object. Throws on bad env.
export function loadConfig(env = process.env) {
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
    WRITE_TOOLS_ENABLED,
    DB_WRITER_USER = 'nutrition_writer',
    DB_WRITER_PASSWORD,
    WRITE_RATE_LIMIT_PER_HOUR = '120',
  } = env;
  const WRITES_ENABLED = WRITE_TOOLS_ENABLED === 'true';

  if (!DB_PASSWORD) {
    throw new Error('DB_PASSWORD is not set.');
  }
  if (!MCP_API_KEY || MCP_API_KEY.length < 32) {
    throw new Error('MCP_API_KEY must be set and at least 32 characters.');
  }
  if (WRITES_ENABLED && !DB_WRITER_PASSWORD) {
    throw new Error('DB_WRITER_PASSWORD must be set when WRITE_TOOLS_ENABLED=true.');
  }
  const rateLimit = Number(WRITE_RATE_LIMIT_PER_HOUR);
  if (!Number.isFinite(rateLimit) || rateLimit < 1) {
    throw new Error('WRITE_RATE_LIMIT_PER_HOUR must be a positive number.');
  }

  return {
    PORT,
    DB_HOST,
    DB_PORT,
    DB_NAME,
    DB_USER,
    DB_PASSWORD,
    MCP_API_KEY,
    QUERY_TIMEOUT_MS,
    MAX_ROWS,
    ALLOWED_HOST,
    OAUTH_STATE_PATH,
    ALLOWED_REDIRECT_URIS,
    WRITES_ENABLED,
    DB_WRITER_USER,
    DB_WRITER_PASSWORD,
    WRITE_RATE_LIMIT_PER_HOUR: rateLimit,
  };
}
