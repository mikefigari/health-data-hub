"""Docs hygiene: relative markdown links resolve, and runbook "check" steps
are read-only. Stdlib only; files are listed with `git ls-files`.
"""
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_NAMES = {"PLAN.md", "LESSONS.md", "RUNLOG.md"}
EXCLUDED_PREFIXES = (".claude/", ".github/")

LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)|!\[[^\]]*\]\(([^)\s]+)\)")
CHECK_RE = re.compile(r"(?i)\b(check|verify|smoke[- ]test)\b[^:\n]*:")
WRITE_PATTERNS = [
    re.compile(r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b"),
    re.compile(r"curl\b.*(-X\s*(POST|PUT|PATCH|DELETE)\b|\s-d\b|\s--data)"),
    re.compile(r"systemctl\s+(start|stop|restart)\b"),
    re.compile(r"docker\s+compose\s+(up|down|restart)\b"),
    re.compile(r"psql\b.*\s-f\s"),
]


def tracked_docs():
    out = subprocess.run(
        ["git", "ls-files", "*.md"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.split()
    return [
        p for p in out
        if p not in EXCLUDED_NAMES and not p.startswith(EXCLUDED_PREFIXES)
    ]


def broken_links(path, text):
    """Relative link targets (anchor stripped) that do not exist."""
    bad = []
    for m in LINK_RE.finditer(text):
        target = (m.group(1) or m.group(2) or "").strip()
        if not target or re.match(r"^([a-zA-Z][a-zA-Z0-9+.-]*:|//|#)", target):
            continue
        target = target.split("#", 1)[0]
        if not target:
            continue
        if not (ROOT / path).parent.joinpath(target).exists():
            bad.append(target)
    return bad


def check_step_blocks(text):
    """Yield (line, code) for each check step: the line plus the fenced block
    that directly follows it (blank lines allowed in between)."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not CHECK_RE.search(line):
            continue
        code = [line]
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j < len(lines) and lines[j].lstrip().startswith("```"):
            j += 1
            while j < len(lines) and not lines[j].lstrip().startswith("```"):
                code.append(lines[j])
                j += 1
        yield line, "\n".join(code)


def write_violations(code):
    return [p.pattern for p in WRITE_PATTERNS if p.search(code)]


def unsafe_check_steps(text):
    return [line for line, code in check_step_blocks(text) if write_violations(code)]


# ---- detector self-tests ----

def _step(cmd):
    return "Verify the state:\n\n```\n%s\n```\n" % cmd


def test_readonly_samples_pass():
    for cmd in [
        "psql -c 'SELECT count(*) FROM t'",
        "curl -s http://localhost:8879/health",
        "systemctl status hdh",
        "docker compose ps",
    ]:
        assert unsafe_check_steps(_step(cmd)) == [], cmd


@pytest.mark.parametrize("cmd", [
    "psql -c 'INSERT INTO t VALUES (1)'",
    "psql -c 'UPDATE t SET a=1'",
    "psql -c 'DELETE FROM t'",
    "psql -c 'DROP TABLE t'",
    "psql -c 'ALTER TABLE t ADD c int'",
    "psql -c 'TRUNCATE t'",
    "psql -c 'GRANT ALL ON t TO x'",
    "psql -c 'REVOKE ALL ON t FROM x'",
    "psql -c 'CREATE TABLE t (a int)'",
    "curl -X POST http://x/y",
    "curl -X PUT http://x/y",
    "curl -X PATCH http://x/y",
    "curl -X DELETE http://x/y",
    "curl -d '{}' http://x/y",
    "curl --data '{}' http://x/y",
    "systemctl start hdh",
    "systemctl stop hdh",
    "systemctl restart hdh",
    "docker compose up -d",
    "docker compose down",
    "docker compose restart",
    "psql -h pi -U postgres -f migrate.sql",
])
def test_write_samples_fail(cmd):
    assert unsafe_check_steps(_step(cmd)), cmd


def test_inline_check_step_detected():
    assert unsafe_check_steps("Check: `systemctl restart hdh`\n")
    assert unsafe_check_steps("Check: `systemctl status hdh`\n") == []


def test_write_outside_check_step_ignored():
    assert unsafe_check_steps("Deploy:\n\n```\nsystemctl restart hdh\n```\n") == []


def test_broken_link_detector():
    assert broken_links("README.md", "[x](no/such/file.md#a)") == ["no/such/file.md"]
    assert broken_links("README.md", "[x](README.md#anchor)") == []
    assert broken_links("README.md", "[x](https://example.com/nope)") == []
    assert broken_links("README.md", "[x](#local)") == []


# ---- the real tree ----

def test_scan_scope():
    docs = tracked_docs()
    assert "README.md" in docs
    for p in docs:
        assert p not in EXCLUDED_NAMES
        assert not p.startswith(EXCLUDED_PREFIXES)


def test_relative_links_resolve():
    problems = []
    for p in tracked_docs():
        text = (ROOT / p).read_text(encoding="utf-8")
        problems += ["%s -> %s" % (p, t) for t in broken_links(p, text)]
    assert problems == []


def test_runbook_check_steps_are_read_only():
    problems = []
    for p in tracked_docs():
        text = (ROOT / p).read_text(encoding="utf-8")
        problems += ["%s: %s" % (p, l) for l in unsafe_check_steps(text)]
    assert problems == []
