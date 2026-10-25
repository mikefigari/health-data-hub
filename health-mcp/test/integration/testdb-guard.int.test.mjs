import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, readonlyPool, closePools } from '../helpers/testdb.mjs';

const ORIGINAL = process.env.TEST_DATABASE_URL;

afterEach(async () => {
  if (ORIGINAL === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = ORIGINAL;
  await closePools();
});

for (const qs of ['?host=prod.example.com', '?user=postgres', '?dbname=prod', '?hostaddr=10.0.0.1']) {
  test(`guard rejects query parameters (${qs})`, async () => {
    process.env.TEST_DATABASE_URL = `postgres://u:p@localhost:5433/hdh_test${qs}`;
    await assert.rejects(resetDb(), /query parameters/);
    await assert.rejects(readonlyPool(), /query parameters/);
  });
}
