"""Every run_* job wrapper in scheduler_all.py must end in a catch-all
`except Exception` so one failing job never kills the scheduler.

scheduler_all.py is parsed with ast, never imported (no side effects).
"""
import ast
from pathlib import Path

SCHEDULER = Path(__file__).resolve().parent.parent / "scheduler_all.py"


def _catches_exception(handler):
    t = handler.type
    if isinstance(t, ast.Name):
        return t.id == "Exception"
    if isinstance(t, ast.Tuple):
        return any(isinstance(e, ast.Name) and e.id == "Exception" for e in t.elts)
    return False


def wrappers_missing_catch_all(source):
    """Return names of top-level run_* functions with no `except Exception`."""
    tree = ast.parse(source)
    wrappers = [
        n for n in tree.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        and n.name.startswith("run_")
    ]
    missing = []
    for fn in wrappers:
        ok = any(
            isinstance(node, ast.Try)
            and any(_catches_exception(h) for h in node.handlers)
            for node in ast.walk(fn)
        )
        if not ok:
            missing.append(fn.name)
    return missing


def _wrapper_names(source):
    return [n.name for n in ast.parse(source).body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            and n.name.startswith("run_")]


def test_scheduler_has_run_wrappers():
    assert _wrapper_names(SCHEDULER.read_text(encoding="utf-8"))


def test_every_run_wrapper_has_catch_all():
    missing = wrappers_missing_catch_all(SCHEDULER.read_text(encoding="utf-8"))
    assert missing == [], f"run_* wrappers lacking `except Exception`: {missing}"


def test_helper_flags_wrapper_catching_only_valueerror():
    src = (
        "def run_x():\n"
        "    try:\n"
        "        do()\n"
        "    except ValueError:\n"
        "        pass\n"
    )
    assert wrappers_missing_catch_all(src) == ["run_x"]


def test_helper_flags_wrapper_without_try():
    assert wrappers_missing_catch_all("def run_y():\n    do()\n") == ["run_y"]


def test_helper_accepts_compliant_wrapper():
    src = (
        "def run_z():\n"
        "    try:\n"
        "        do()\n"
        "    except Exception:\n"
        "        return 1\n"
    )
    assert wrappers_missing_catch_all(src) == []
