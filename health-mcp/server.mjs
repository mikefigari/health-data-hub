import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { createPools } from './db.mjs';
import { registerNutritionTools } from './tools/nutrition/index.mjs';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`${err.message} Exiting.`);
  process.exit(1);
}

const { read: pool, write: writePool } = createPools(config);

const app = createApp({ config, pool, writePool, registerTools: registerNutritionTools });

app.listen(Number(config.PORT), '127.0.0.1', () => {
  console.log(`health-mcp listening on 127.0.0.1:${config.PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
