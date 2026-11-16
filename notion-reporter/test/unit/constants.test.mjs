// T13-spec. Maintenance (2620), plan pace (0.6545) and kcal/kg (7700) live in one place;
// prompt text interpolates the configured maintenance (env MAINTENANCE_KCAL).
// Daily prompt is currently commented out in analyzeHealth.mjs, so the daily text is covered by
// the source scan (a); the active weekly prompt is checked at runtime (b, c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, relative, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = join(root, 'src');

const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = [...walk(srcDir).filter((f) => /\.(m?js|cjs)$/.test(f)), join(root, 'index.mjs')];
const rel = (f) => relative(root, f).split(sep).join('/');
const count = (s, needle) => s.split(needle).length - 1;

test('(a) constants appear only in their single source of truth', () => {
  const owner = 'src/utils/nutritionWeek.mjs';
  let total7700 = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (rel(f) !== owner) {
      assert.equal(count(text, '2620'), 0, `2620 found in ${rel(f)}`);
      assert.equal(count(text, '0.6545'), 0, `0.6545 found in ${rel(f)}`);
    }
    total7700 += count(text, '7700');
  }
  assert.equal(total7700, 1, '7700 must appear exactly once');
  const own = readFileSync(join(root, owner), 'utf8');
  assert.ok(own.includes('2620') && own.includes('0.6545'), 'defaults stay in nutritionWeek.mjs');
});

let n = 0;
async function weeklyPrompt(envValue) {
  const prev = process.env.MAINTENANCE_KCAL;
  if (envValue === undefined) delete process.env.MAINTENANCE_KCAL;
  else process.env.MAINTENANCE_KCAL = envValue;
  try {
    const url = pathToFileURL(join(srcDir, 'anthropic', 'analyzeHealth.mjs')).href + `?t13=${++n}`;
    const mod = await import(url);
    const p = mod.WEEKLY_SYSTEM_PROMPT;
    return typeof p === 'function' ? p() : p;
  } finally {
    if (prev === undefined) delete process.env.MAINTENANCE_KCAL;
    else process.env.MAINTENANCE_KCAL = prev;
  }
}

test('(b) with maintenance env unset the weekly prompt states 2620', async () => {
  const p = await weeklyPrompt(undefined);
  assert.equal(typeof p, 'string');
  assert.match(p, /2620/);
});

test('(c) with maintenance env set to 2500 the weekly prompt uses 2500, not 2620', async () => {
  const p = await weeklyPrompt('2500');
  assert.match(p, /2500/);
  assert.doesNotMatch(p, /2620/);
});
