// Single source for the plan pace and maintenance defaults.
const DEFAULT_PLAN_KG_PER_WEEK = '0.6545';
const DEFAULT_MAINTENANCE_KCAL = '2620';

// Lenient read of the two energy settings (no token/DB validation); invalid values fall back to the defaults.
export function energyDefaults(env = process.env) {
  const pick = (v, d) => {
    const n = Number(v ?? d);
    return Number.isFinite(n) && n > 0 ? n : Number(d);
  };
  return {
    PLAN_KG_PER_WEEK: pick(env.PLAN_KG_PER_WEEK, DEFAULT_PLAN_KG_PER_WEEK),
    MAINTENANCE_KCAL: pick(env.MAINTENANCE_KCAL, DEFAULT_MAINTENANCE_KCAL),
  };
}

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
    PLAN_KG_PER_WEEK = DEFAULT_PLAN_KG_PER_WEEK,
    MAINTENANCE_KCAL = DEFAULT_MAINTENANCE_KCAL,
    PROTEIN_PCT_MIN = '35',
    PROTEIN_PCT_MAX = '40',
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
  const maintenance = Number(MAINTENANCE_KCAL);
  if (!Number.isFinite(maintenance) || maintenance <= 0) {
    throw new Error('MAINTENANCE_KCAL must be a positive number.');
  }
  const proteinMin = PROTEIN_PCT_MIN.trim() === '' ? NaN : Number(PROTEIN_PCT_MIN);
  const proteinMax = PROTEIN_PCT_MAX.trim() === '' ? NaN : Number(PROTEIN_PCT_MAX);
  if (!Number.isFinite(proteinMin) || !Number.isFinite(proteinMax)) {
    throw new Error('PROTEIN_PCT_MIN and PROTEIN_PCT_MAX must be numbers.');
  }
  if (proteinMin < 0 || proteinMax > 100 || proteinMin >= proteinMax) {
    throw new Error('PROTEIN_PCT_MIN and PROTEIN_PCT_MAX must satisfy 0 <= min < max <= 100.');
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
    MAINTENANCE_KCAL: maintenance,
    PROTEIN_PCT_MIN: proteinMin,
    PROTEIN_PCT_MAX: proteinMax,
  };
}
