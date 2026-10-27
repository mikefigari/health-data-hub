const TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

// Reads and validates configuration from an env-like object. Throws on bad env.
export function loadConfig(env = process.env) {
  const {
    PORT = '8878',
    HOST = '127.0.0.1',
    DB_HOST = 'localhost',
    DB_PORT = '5432',
    DB_NAME = 'health_pi',
    DB_USER = 'dashboard_ro',
    DB_PASSWORD,
    DASHBOARD_TOKENS = '',
    DASHBOARD_DEMO,
    FRAME_ANCESTORS = 'https://www.notion.so https://notion.so https://*.notion.site',
    PLAN_KG_PER_WEEK = '0.75',
    QUERY_TIMEOUT_MS = '10000',
  } = env;
  const DEMO = DASHBOARD_DEMO === 'true';

  const TOKENS = DASHBOARD_TOKENS.split(',').map((t) => t.trim());
  if (!DASHBOARD_TOKENS.trim() || TOKENS.some((t) => !TOKEN_RE.test(t))) {
    throw new Error(
      'DASHBOARD_TOKENS must be a comma-separated list of tokens, each at least 32 characters from [A-Za-z0-9_-].'
    );
  }
  if (!DEMO && !DB_PASSWORD) {
    throw new Error('DB_PASSWORD is not set.');
  }
  const planKg = Number(PLAN_KG_PER_WEEK);
  if (!Number.isFinite(planKg) || planKg <= 0) {
    throw new Error('PLAN_KG_PER_WEEK must be a positive number.');
  }

  return {
    PORT,
    HOST,
    DB_HOST,
    DB_PORT,
    DB_NAME,
    DB_USER,
    DB_PASSWORD,
    TOKENS,
    DEMO,
    FRAME_ANCESTORS,
    PLAN_KG_PER_WEEK: planKg,
    QUERY_TIMEOUT_MS,
  };
}
