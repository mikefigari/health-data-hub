// T9 spec: dashboard/Dockerfile + dashboard/.dockerignore, checked as text only.
// No `docker build` here: the Dockerfile is parsed into instructions and inspected.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOCKERFILE = fileURLToPath(new URL('../../Dockerfile', import.meta.url));
const DOCKERIGNORE = fileURLToPath(new URL('../../.dockerignore', import.meta.url));

function readOrFail(path, label) {
  assert.ok(existsSync(path), `${label} must exist at ${path}`);
  return readFileSync(path, 'utf8');
}

// Parse a Dockerfile into [{ op, args }] with comments dropped and
// backslash line continuations joined.
function parseDockerfile(text) {
  const out = [];
  let buf = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!buf && /^\s*#/.test(line)) continue;
    if (!buf && line.trim() === '') continue;
    if (line.endsWith('\\')) {
      buf += line.slice(0, -1) + ' ';
      continue;
    }
    buf += line;
    const m = buf.trim().match(/^(\w+)\s*(.*)$/s);
    if (m) out.push({ op: m[1].toUpperCase(), args: m[2].trim() });
    buf = '';
  }
  if (buf.trim()) {
    const m = buf.trim().match(/^(\w+)\s*(.*)$/s);
    if (m) out.push({ op: m[1].toUpperCase(), args: m[2].trim() });
  }
  return out;
}

function load() {
  return parseDockerfile(readOrFail(DOCKERFILE, 'Dockerfile'));
}

function indexWhere(ins, pred) {
  return ins.findIndex(pred);
}
function lastIndexWhere(ins, pred) {
  for (let i = ins.length - 1; i >= 0; i--) if (pred(ins[i])) return i;
  return -1;
}

// COPY sources (all tokens except the last, ignoring --flags). Handles JSON form.
function copySources(args) {
  let tokens;
  const trimmed = args.trim();
  const flagless = trimmed.replace(/^(--\S+\s+)+/, '');
  if (flagless.startsWith('[')) {
    tokens = JSON.parse(flagless);
  } else {
    tokens = flagless.split(/\s+/);
  }
  return tokens.slice(0, -1).map((t) => t.replace(/^\.\//, '').replace(/\/$/, ''));
}

const isNpmCi = (i) => i.op === 'RUN' && /\bnpm\s+ci\b/.test(i.args);
const isCopy = (i) => i.op === 'COPY' || i.op === 'ADD';
const SOURCE_PATHS = ['.', 'src', 'public', 'server.mjs'];
const isSourceCopy = (i) => isCopy(i) && copySources(i.args).some((s) => SOURCE_PATHS.includes(s));

describe('Dockerfile base image (a)', () => {
  test('every FROM is node:22 bookworm-slim, tag pinned, no latest, no hard-coded platform', () => {
    const froms = load().filter((i) => i.op === 'FROM');
    assert.ok(froms.length >= 1, 'Dockerfile needs a FROM');
    const re = /^node:22(\.\d+){0,2}-bookworm-slim(@sha256:[0-9a-f]{64})?(\s+AS\s+[A-Za-z0-9_.-]+)?$/i;
    for (const f of froms) {
      assert.doesNotMatch(f.args, /--platform/, `FROM must not pin a platform (multi-arch): ${f.args}`);
      assert.doesNotMatch(f.args, /latest/i, `FROM must not use latest: ${f.args}`);
      assert.match(f.args, re, `FROM must be node:22-bookworm-slim (optionally @sha256 / AS name): ${f.args}`);
    }
  });
});

describe('Dockerfile install layer caching (b)', () => {
  test('RUN npm ci --omit=dev exists', () => {
    const ins = load();
    const i = indexWhere(ins, isNpmCi);
    assert.ok(i >= 0, 'needs RUN npm ci');
    assert.match(ins[i].args, /npm\s+ci\b[^&;|]*--omit=dev/, 'npm ci must use --omit=dev');
  });

  test('package-lock.json is copied (not via COPY . .) before npm ci', () => {
    const ins = load();
    const ci = indexWhere(ins, isNpmCi);
    assert.ok(ci >= 0, 'needs RUN npm ci');
    const lock = indexWhere(ins, (i) => isCopy(i) && copySources(i.args).some((s) => s === 'package-lock.json' || s === 'package*.json'));
    assert.ok(lock >= 0, 'a COPY of package-lock.json (or package*.json) is required');
    assert.ok(lock < ci, 'package-lock.json must be copied before npm ci');
    assert.ok(!copySources(ins[lock].args).includes('.'), 'the lockfile COPY must not be COPY . .');
  });

  test('application source is copied only after npm ci', () => {
    const ins = load();
    const ci = indexWhere(ins, isNpmCi);
    const src = indexWhere(ins, isSourceCopy);
    assert.ok(ci >= 0, 'needs RUN npm ci');
    assert.ok(src >= 0, 'source must be copied into the image');
    assert.ok(src > ci, 'source COPY must come after npm ci for layer caching');
  });

  test('server.mjs, src and public all reach the image', () => {
    const copies = load().filter(isCopy).flatMap((i) => copySources(i.args));
    if (copies.includes('.')) return;
    for (const p of ['server.mjs', 'src', 'public']) {
      assert.ok(copies.includes(p), `COPY must include ${p} (or use COPY . . after install)`);
    }
  });
});

describe('Dockerfile runtime user and command (c)', () => {
  test('USER node is set before CMD and not reset afterwards', () => {
    const ins = load();
    const cmd = lastIndexWhere(ins, (i) => i.op === 'CMD');
    assert.ok(cmd >= 0, 'needs CMD');
    const lastUser = lastIndexWhere(ins.slice(0, cmd), (i) => i.op === 'USER');
    assert.ok(lastUser >= 0, 'needs USER before CMD');
    assert.match(ins[lastUser].args, /^node(:node)?$/, `last USER before CMD must be node, got ${ins[lastUser].args}`);
    const userAfter = ins.slice(cmd + 1).some((i) => i.op === 'USER');
    assert.ok(!userAfter, 'no USER change after CMD');
  });

  test('CMD runs node server.mjs', () => {
    const ins = load();
    const cmd = ins[lastIndexWhere(ins, (i) => i.op === 'CMD')];
    assert.ok(cmd, 'needs CMD');
    let argv;
    if (cmd.args.startsWith('[')) argv = JSON.parse(cmd.args);
    else argv = cmd.args.split(/\s+/);
    assert.deepEqual(argv, ['node', 'server.mjs']);
  });
});

describe('Dockerfile healthcheck (d)', () => {
  test('HEALTHCHECK uses node -e fetch on 127.0.0.1:$PORT/healthz, no curl/wget', () => {
    const ins = load();
    const hcs = ins.filter((i) => i.op === 'HEALTHCHECK');
    assert.equal(hcs.length, 1, 'exactly one HEALTHCHECK');
    const hc = hcs[0].args;
    assert.match(hc, /\bCMD\b/, 'HEALTHCHECK needs CMD');
    assert.doesNotMatch(hc, /\b(curl|wget)\b/, 'slim image has no curl/wget');
    const flat = hc.replace(/\s+/g, '');
    assert.ok(/"node","-e"/.test(flat) || /CMDnode-e/.test(flat), 'HEALTHCHECK must run node -e');
    assert.ok(
      flat.includes("fetch('http://127.0.0.1:'+(process.env.PORT||8878)+'/healthz')"),
      `HEALTHCHECK must fetch('http://127.0.0.1:'+(process.env.PORT||8878)+'/healthz'), got: ${hc}`,
    );
    assert.match(hc, /process\.exit/, 'HEALTHCHECK must exit non-zero when the check fails');
    assert.match(hc, /\.ok\b|\.status\b/, 'HEALTHCHECK must inspect the response status');
  });
});

describe('Dockerfile contains no secrets (e)', () => {
  test('no ENV or ARG mentions PASSWORD, TOKEN or SECRET', () => {
    for (const i of load()) {
      if (i.op !== 'ENV' && i.op !== 'ARG') continue;
      assert.doesNotMatch(i.args, /PASSWORD|TOKEN|SECRET/i, `${i.op} ${i.args} looks like a secret`);
    }
  });

  test('no env file is copied into the image', () => {
    for (const i of load().filter(isCopy)) {
      for (const s of copySources(i.args)) {
        assert.doesNotMatch(s, /\.env$/, `COPY must not include env files: ${s}`);
      }
    }
  });
});

describe('.dockerignore (f)', () => {
  function entries() {
    return readOrFail(DOCKERIGNORE, '.dockerignore')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.replace(/^(\*\*\/|\/)/, '').replace(/\/$/, ''));
  }

  test('lists node_modules, *.env, test and .git', () => {
    const e = entries();
    for (const want of ['node_modules', '*.env', 'test', '.git']) {
      assert.ok(e.includes(want), `.dockerignore must list ${want}; has: ${e.join(', ')}`);
    }
  });

  test('does not exclude files the image needs', () => {
    const e = entries();
    for (const need of ['package.json', 'package-lock.json', 'server.mjs', 'src', 'public', '*.json', '*.mjs']) {
      assert.ok(!e.includes(need), `.dockerignore must not exclude ${need}`);
    }
  });
});
