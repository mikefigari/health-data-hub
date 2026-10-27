import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../src/config.mjs';

const path = new URL('../../dashboard.env.example', import.meta.url);

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

const example = parseEnv(readFileSync(path, 'utf8'));

test('example DASHBOARD_TOKENS placeholder is rejected by loadConfig', () => {
  assert.ok(example.DASHBOARD_TOKENS, 'example must define DASHBOARD_TOKENS');
  assert.throws(
    () => loadConfig({ ...example, DB_PASSWORD: 'x' }),
    /DASHBOARD_TOKENS/
  );
});

test('example FRAME_ANCESTORS has no quote characters', () => {
  assert.ok(example.FRAME_ANCESTORS);
  assert.ok(!/["']/.test(example.FRAME_ANCESTORS));
});
