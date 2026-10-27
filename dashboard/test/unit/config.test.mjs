// T15 spec: protein band config (D12). PROTEIN_PCT_MIN / PROTEIN_PCT_MAX, defaults 35 and 40.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadConfig } from '../../src/config.mjs';

const TOKEN = 'a'.repeat(40);
const env = (o = {}) => ({ DASHBOARD_TOKENS: TOKEN, DB_PASSWORD: 'x', ...o });

describe('protein band config (D12)', () => {
  test('defaults are 35 and 40 (numbers)', () => {
    const c = loadConfig(env());
    assert.equal(c.PROTEIN_PCT_MIN, 35);
    assert.equal(c.PROTEIN_PCT_MAX, 40);
  });

  test('env overrides are parsed as numbers', () => {
    const c = loadConfig(env({ PROTEIN_PCT_MIN: '30', PROTEIN_PCT_MAX: '42.5' }));
    assert.equal(c.PROTEIN_PCT_MIN, 30);
    assert.equal(c.PROTEIN_PCT_MAX, 42.5);
  });

  test('bounds 0 and 100 are accepted', () => {
    const c = loadConfig(env({ PROTEIN_PCT_MIN: '0', PROTEIN_PCT_MAX: '100' }));
    assert.equal(c.PROTEIN_PCT_MIN, 0);
    assert.equal(c.PROTEIN_PCT_MAX, 100);
  });

  const bad = [
    ['non-numeric min', { PROTEIN_PCT_MIN: 'abc' }],
    ['non-numeric max', { PROTEIN_PCT_MAX: 'lots' }],
    ['min equals max', { PROTEIN_PCT_MIN: '40', PROTEIN_PCT_MAX: '40' }],
    ['min greater than max', { PROTEIN_PCT_MIN: '45', PROTEIN_PCT_MAX: '40' }],
    ['min above the default max alone', { PROTEIN_PCT_MIN: '41' }],
    ['min below 0', { PROTEIN_PCT_MIN: '-1' }],
    ['max above 100', { PROTEIN_PCT_MAX: '101' }],
  ];
  for (const [name, o] of bad) {
    test(`throws: ${name}`, () => {
      assert.throws(() => loadConfig(env(o)), /PROTEIN_PCT/);
    });
  }

  test('dashboard.env.example lists both variables', () => {
    const text = readFileSync(new URL('../../dashboard.env.example', import.meta.url), 'utf8');
    assert.match(text, /^PROTEIN_PCT_MIN=/m);
    assert.match(text, /^PROTEIN_PCT_MAX=/m);
  });
});
