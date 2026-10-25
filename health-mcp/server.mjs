import pg from 'pg';
import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`${err.message} Exiting.`);
  process.exit(1);
}

const pool = new pg.Pool({
  host: config.DB_HOST,
  port: Number(config.DB_PORT),
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
  statement_timeout: Number(config.QUERY_TIMEOUT_MS),
});

const app = createApp({ config, pool });

app.listen(Number(config.PORT), '127.0.0.1', () => {
  console.log(`health-mcp listening on 127.0.0.1:${config.PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
