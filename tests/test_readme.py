"""README describes the current system; stale chart-vendor and nutrition_poller
instructions are gone. Stdlib only.
"""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_NAMES = {"PLAN.md", "LESSONS.md", "RUNLOG.md"}
WORD = "data" + "wrapper"


def section(text, heading):
    m = re.search(
        r"^## " + re.escape(heading) + r"[ \t]*$(.*?)(?=^## |\Z)", text, re.M | re.S
    )
    assert m, f"README.md has no '## {heading}' section"
    return m.group(1)


def ci_npm_test_dirs():
    """Directories kit-ci.yml runs `npm test` in (step working-directory,
    else the job default)."""
    lines = (ROOT / ".github/workflows/kit-ci.yml").read_text(encoding="utf-8").splitlines()
    default = None
    for ln in lines:
        m = re.match(r"\s+working-directory:\s*(\S+)", ln)
        if m:
            default = m.group(1)
            break
    steps, cur = [], []
    for ln in lines:
        if re.match(r"\s+- ", ln):
            steps.append(cur)
            cur = []
        cur.append(ln)
    steps.append(cur)
    dirs = set()
    for step in steps:
        body = "\n".join(step)
        if re.search(r"run:\s*npm test\s*$", body, re.M):
            m = re.search(r"working-directory:\s*(\S+)", body)
            dirs.add(m.group(1) if m else default)
    dirs.discard(None)
    return dirs


def test_components_section_names_components():
    sec = section((ROOT / "README.md").read_text(encoding="utf-8"), "Components")
    for name in ["health_data_hub/", "scheduler_all.py", "health-mcp/",
                 "notion-reporter/", "dashboard/", "cloudflare-worker/"]:
        assert name in sec, f"Components section does not name {name}"


def test_tests_section_commands_and_dirs():
    sec = section((ROOT / "README.md").read_text(encoding="utf-8"), "Tests")
    assert "venv/Scripts/python -m pytest -q" in sec
    assert "npm test" in sec
    dirs = ci_npm_test_dirs()
    assert dirs, "could not find npm test directories in kit-ci.yml"
    for d in dirs:
        assert d in sec, f"Tests section does not name {d}"


def test_no_vendor_word_in_tracked_files():
    files = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    offenders = []
    for f in files:
        if f in EXCLUDED_NAMES:
            continue
        p = ROOT / f
        if not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if WORD in text.lower():
            offenders.append(f)
    assert not offenders, f"vendor word still mentioned in: {offenders}"


def test_health_auto_export_setup_has_no_nutrition_poller():
    text = (ROOT / "docs/health_auto_export_setup.md").read_text(encoding="utf-8")
    assert "nutrition_poller" not in text
