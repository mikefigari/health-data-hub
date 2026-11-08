// T12 spec: maintenance, plan pace and kcal/kg live in one place each.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'public', 'js'))];
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const count = (text, re) => (text.match(re) || []).length;

describe('single source for constants', () => {
  test('2620 and 0.6545 appear only in src/config.mjs', () => {
    for (const lit of [/(?<![\d.])2620(?![\d])/g, /(?<![\d.])0\.6545(?!\d)/g]) {
      const hits = files.filter((f) => count(readFileSync(f, 'utf8'), lit) > 0).map(rel);
      assert.deepEqual(hits, ['src/config.mjs'], `${lit} found in ${hits.join(', ')}`);
    }
  });

  test('7700 appears exactly once', () => {
    const total = files.reduce((n, f) => n + count(readFileSync(f, 'utf8'), /(?<![\d.])7700(?![\d])/g), 0);
    assert.equal(total, 1);
  });
});

// Env is read when modules load, so exercise them in a child with a controlled env.
function inChild(extraEnv, code) {
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    DASHBOARD_TOKENS: 'a'.repeat(40),
    DASHBOARD_DEMO: 'true',
    ...extraEnv,
  };
  const url = (f) => pathToFileURL(join(ROOT, 'src', f)).href;
  const script = `const A = await import(${JSON.stringify(url('aggregate.mjs'))});
const D = await import(${JSON.stringify(url('demo.mjs'))});
const C = await import(${JSON.stringify(url('config.mjs'))});
${code}`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const AGG = `const r = A.buildDashboard({ today: '2026-10-26', rangeDays: 7, planKgPerWeek: 0.75,
  weights: [], nutrition: [], goals: [], rideKj: [], ftp: [] });
console.log(JSON.stringify({ m: r.energy.maintenance_kcal }));`;

describe('config-driven values', () => {
  test('aggregate without maintenanceKcal uses the config default 2620', () => {
    assert.equal(inChild({}, AGG).m, 2620);
  });

  test('MAINTENANCE_KCAL=2500 drives the aggregate maintenance', () => {
    assert.equal(inChild({ MAINTENANCE_KCAL: '2500' }, AGG).m, 2500);
  });

  test('demo planKgPerWeek equals config PLAN_KG_PER_WEEK', () => {
    const code = `console.log(JSON.stringify({ d: D.demoInputs('2026-10-26').planKgPerWeek, c: C.loadConfig(process.env).PLAN_KG_PER_WEEK }));`;
    for (const env of [{}, { PLAN_KG_PER_WEEK: '0.5' }]) {
      const r = inChild(env, code);
      assert.equal(r.d, r.c);
    }
    assert.equal(inChild({}, code).d, 0.6545);
  });
});
