import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'check-unused-exports.mjs');

// Builds a throwaway git repo from { relPath: content }, tracks every file
// (force-added, so node_modules works), copies the checker in untracked, runs it.
function run(files, { allow } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'unused-exports-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    const r = git('add', '-f', '--', ...Object.keys(files));
    assert.equal(r.status, 0, r.stderr);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(SCRIPT, join(dir, 'scripts', 'check-unused-exports.mjs'));
    writeFileSync(join(dir, 'scripts', 'unused-exports.allow'), allow ?? '');
    const res = spawnSync(process.execPath, ['scripts/check-unused-exports.mjs'], {
      cwd: dir,
      encoding: 'utf8',
    });
    const lines = (res.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return { code: res.status, lines, stderr: res.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('collects function, const, let, class and async function exports', () => {
  const { code, lines } = run({
    'svc/a.mjs': [
      'export function fnX() {}',
      'export const constX = 1;',
      'export let letX = 2;',
      'export class ClassX {}',
      'export async function asyncX() {}',
      '',
    ].join('\n'),
  });
  assert.equal(code, 1);
  assert.deepEqual(
    [...lines].sort(),
    ['svc/a.mjs ClassX', 'svc/a.mjs asyncX', 'svc/a.mjs constX', 'svc/a.mjs fnX', 'svc/a.mjs letX'],
  );
});

test('collects export lists and uses the alias as the exported name', () => {
  const { code, lines } = run({
    'svc/a.mjs': 'const a = 1, b = 2;\nexport { a, b as c };\n',
  });
  assert.equal(code, 1);
  assert.deepEqual([...lines].sort(), ['svc/a.mjs a', 'svc/a.mjs c']);
});

test('a whole-word mention in another file counts as use, tests included', () => {
  const { code, lines } = run({
    'svc/a.mjs': 'export function usedByCode() {}\nexport function usedByTest() {}\nexport function orphan() {}\n',
    'svc/b.mjs': "import { usedByCode } from './a.mjs';\nusedByCode();\n",
    'svc/test/a.test.mjs': "import { usedByTest } from '../a.mjs';\nusedByTest();\n",
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['svc/a.mjs orphan']);
});

test('substring matches do not count as use', () => {
  const { code, lines } = run({
    'svc/a.mjs': 'export function foo() {}\n',
    'svc/b.mjs': 'const foobar = 1; const xfoo = 2; foobar + xfoo;\n',
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['svc/a.mjs foo']);
});

test('a mention in the exporting file itself does not count', () => {
  const { code, lines } = run({
    'svc/a.mjs': 'export function selfRef() { return selfRef; }\n',
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['svc/a.mjs selfRef']);
});

test('non-js files do not count as references', () => {
  const { code, lines } = run({
    'svc/a.mjs': 'export function docOnly() {}\n',
    'svc/README.md': 'docOnly is documented here\n',
  });
  assert.equal(code, 1);
  assert.deepEqual(lines, ['svc/a.mjs docOnly']);
});

test('namespace import marks every export of the target used', () => {
  const { code, lines } = run({
    'svc/x.mjs': 'export function one() {}\nexport const two = 2;\n',
    'svc/y.mjs': "import * as ns from './x.mjs';\nconsole.log(ns);\n",
  });
  assert.equal(code, 0);
  assert.deepEqual(lines, []);
});

test('allowlisted path/name pairs are skipped, others still reported', () => {
  const { code, lines } = run(
    {
      'svc/a.mjs': 'export function keepMe() {}\nexport function reportMe() {}\n',
    },
    { allow: 'svc/a.mjs keepMe  # public entry point\n' },
  );
  assert.equal(code, 1);
  assert.deepEqual(lines, ['svc/a.mjs reportMe']);
});

test('exit 0 and no output when everything is used', () => {
  const { code, lines } = run({
    'svc/a.mjs': 'export function alpha() {}\n',
    'svc/b.mjs': "import { alpha } from './a.mjs';\nalpha();\n",
  });
  assert.equal(code, 0);
  assert.deepEqual(lines, []);
});

test('emits exactly one "path name" line per finding', () => {
  const { code, lines } = run({
    'a/one.mjs': 'export const p = 1;\n',
    'b/two.js': 'export const q = 2;\n',
  });
  assert.equal(code, 1);
  assert.deepEqual([...lines].sort(), ['a/one.mjs p', 'b/two.js q']);
});

test('skips node_modules and package-lock.json when scanning', () => {
  const { code, lines } = run({
    'svc/a.mjs': 'export function foo() {}\n',
    'svc/node_modules/pkg/index.js': 'export function vendored() {}\nfoo();\n',
    'svc/package-lock.json': '{"name":"foo"}\n',
  });
  assert.equal(code, 1);
  // vendored export is not reported, and its mention of foo is not a reference
  assert.deepEqual(lines, ['svc/a.mjs foo']);
});

test('scans only git-tracked files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unused-exports-untracked-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(SCRIPT, join(dir, 'scripts', 'check-unused-exports.mjs'));
    writeFileSync(join(dir, 'scripts', 'unused-exports.allow'), '');
    writeFileSync(join(dir, 'a.mjs'), 'export function tracked() {}\n');
    writeFileSync(join(dir, 'b.mjs'), 'tracked();\n'); // untracked reference
    spawnSync('git', ['add', 'a.mjs'], { cwd: dir });
    const res = spawnSync(process.execPath, ['scripts/check-unused-exports.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.deepEqual(res.stdout.split(/\r?\n/).filter(Boolean), ['a.mjs tracked']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
