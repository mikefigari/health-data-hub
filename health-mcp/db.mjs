import pg from 'pg';

// Builds the pools. `read` always logs in as DB_USER (claude_readonly). `write`
// exists only when WRITE_TOOLS_ENABLED=true and logs in as DB_WRITER_USER.
export function createPools(config) {
  const base = {
    host: config.DB_HOST,
    port: Number(config.DB_PORT),
    database: config.DB_NAME,
    idleTimeoutMillis: 30000,
    statement_timeout: Number(config.QUERY_TIMEOUT_MS),
  };
  const read = new pg.Pool({ ...base, user: config.DB_USER, password: config.DB_PASSWORD, max: 5 });
  const write = config.WRITES_ENABLED
    ? new pg.Pool({ ...base, user: config.DB_WRITER_USER, password: config.DB_WRITER_PASSWORD, max: 3 })
    : null;
  return { read, write };
}
