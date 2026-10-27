import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', 'config', '-q'], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env, DASHBOARD_ENV_FILE: './dashboard.env.example' },
});
if (r.error) {
  console.error(r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
