import pg from 'pg';
import { loadConfig } from './src/config.mjs';
import { createApp } from './src/app.mjs';
import { checkReadOnly } from './src/queries.mjs';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`${err.message} Exiting.`);
  process.exit(1);
}

const pool = config.DEMO
  ? null
  : new pg.Pool({
      host: config.DB_HOST,
      port: Number(config.DB_PORT),
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      max: 3,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
    });

if (pool) {
  pool.on('error', (err) => {
    console.error(`pool error code=${err.code ?? 'none'} message=${err.message}`);
  });
  try {
    await checkReadOnly(pool);
  } catch (err) {
    console.error(`Read-only check failed (${err?.code ?? 'none'}): ${err?.message}. Exiting.`);
    process.exit(1);
  }
}

const app = createApp({ config, pool });

app.listen(Number(config.PORT), config.HOST, () => {
  console.log(`health-dashboard listening on ${config.HOST}:${config.PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
