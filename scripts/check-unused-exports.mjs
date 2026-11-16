#!/usr/bin/env node
// Reports exports that no other tracked .mjs/.js file references (whole-word match).
// Prints one "path name" line per finding and exits 1 if any exist.
// Allowlist: scripts/unused-exports.allow, one `path name  # reason` per line.
// Ambiguous patterns (re-exports, dynamic import, namespace import) count as used.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ALLOW_FILE = resolve(here, 'unused-exports.allow');

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(Boolean)
  .map((p) => p.replace(/\\/g, '/'))
  .filter((p) => /\.(mjs|js)$/.test(p) && !p.split('/').includes('node_modules'));

const src = new Map(tracked.map((p) => [p, readFileSync(p, 'utf8')]));

const allow = new Set();
if (existsSync(ALLOW_FILE)) {
  for (const raw of readFileSync(ALLOW_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line) allow.add(line.split(/\s+/).slice(0, 2).join(' '));
  }
}

function collectExports(text) {
  const names = new Set();
  const decl =
    /^[ \t]*export\s+(?:async\s+function\s*\*?|function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(decl)) names.add(m[1]);
  const list = /^[ \t]*export\s*\{([^}]*)\}\s*(from\s*['"][^'"]+['"])?/gm;
  for (const m of text.matchAll(list)) {
    if (m[2]) continue; // re-export: ambiguous, treat as used
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const name = t.split(/\s+as\s+/).pop().trim();
      if (name && name !== 'default') names.add(name);
    }
  }
  return names;
}

// Files fully used through `import * as ns from` or dynamic import().
const wholeUsed = new Set();
const nsImport = /(?:import\s*\*\s*as\s+[\w$]+\s*from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
for (const [file, text] of src) {
  for (const m of text.matchAll(nsImport)) {
    if (!m[1].startsWith('.')) continue;
    wholeUsed.add(posix.normalize(posix.join(posix.dirname(file), m[1])));
  }
}

const esc = (s) => s.replace(/[$]/g, '\\$&');
const findings = [];
for (const [file, text] of src) {
  if (wholeUsed.has(file)) continue;
  for (const name of collectExports(text)) {
    if (allow.has(`${file} ${name}`)) continue;
    const re = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`);
    let used = false;
    for (const [other, otherText] of src) {
      if (other !== file && re.test(otherText)) {
        used = true;
        break;
      }
    }
    if (!used) findings.push(`${file} ${name}`);
  }
}

if (findings.length) process.stdout.write(findings.join('\n') + '\n');
process.exitCode = findings.length ? 1 : 0;
