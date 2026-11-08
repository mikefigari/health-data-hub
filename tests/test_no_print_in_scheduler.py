"""Modules reachable from scheduler_all.py must log, not print.

The import closure is built with ast (nothing is imported for it).
print() is allowed only inside an `if __name__ == "__main__":` block.
"""
import ast
import io
import logging
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCHEDULER = ROOT / "scheduler_all.py"
PKG = "health_data_hub"


def _module_path(name):
    base = ROOT.joinpath(*name.split("."))
    if base.is_dir() and (base / "__init__.py").exists():
        return base / "__init__.py"
    py = base.with_suffix(".py")
    return py if py.exists() else None


def _imported_names(tree):
    names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.append(node.module)
            names += [f"{node.module}.{a.name}" for a in node.names]
    return [n for n in names if n == PKG or n.startswith(PKG + ".")]


def import_closure():
    seen = {}
    todo = _imported_names(ast.parse(SCHEDULER.read_text(encoding="utf-8")))
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        path = _module_path(name)
        if path is None:
            continue
        seen[name] = path
        # importing a.b.c also imports packages a and a.b
        parts = name.split(".")
        todo += [".".join(parts[:i]) for i in range(1, len(parts))]
        todo += _imported_names(ast.parse(path.read_text(encoding="utf-8")))
    return seen


def _is_main_guard(node):
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    t = node.test
    return (
        isinstance(t.left, ast.Name)
        and t.left.id == "__name__"
        and len(t.comparators) == 1
        and isinstance(t.comparators[0], ast.Constant)
        and t.comparators[0].value == "__main__"
    )


def print_lines(source):
    """Line numbers of print() calls outside `if __name__ == "__main__":`."""
    found = []

    def visit(node):
        if _is_main_guard(node):
            return
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "print"
        ):
            found.append(node.lineno)
        for child in ast.iter_child_nodes(node):
            visit(child)

    visit(ast.parse(source))
    return found


def test_closure_is_not_empty():
    closure = import_closure()
    assert "health_data_hub.integrations.poll_strava" in closure
    assert "health_data_hub.integrations.notion.notion_strava_sync" in closure


def test_print_lines_helper_respects_main_guard():
    src = 'print(1)\nif __name__ == "__main__":\n    print(2)\n'
    assert print_lines(src) == [1]


def test_no_print_in_scheduler_reachable_modules():
    offenders = {}
    for name, path in import_closure().items():
        lines = print_lines(path.read_text(encoding="utf-8"))
        if lines:
            offenders[name] = lines
    assert not offenders, f"print() found: {offenders}"


def test_oauth_failure_does_not_log_response_body(caplog, capsys):
    from health_data_hub.etl.extract import strava_oauth

    secret = "SUPERSECRETTOKENVALUE123"
    body = {"message": "Bad Request", "detail": f"access_token={secret}"}
    resp = mock.Mock()
    resp.json.return_value = body

    handler = object.__new__(strava_oauth.OAuthHandler)
    handler.path = "/?code=abc"
    handler.wfile = io.BytesIO()
    handler.send_response = mock.Mock()
    handler.end_headers = mock.Mock()
    handler.server = mock.Mock()

    env = {"STRAVA_CLIENT_ID": "cid", "STRAVA_CLIENT_SECRET": "csecret"}
    with caplog.at_level(logging.DEBUG), \
            mock.patch.dict("os.environ", env), \
            mock.patch.object(strava_oauth.requests, "post", return_value=resp):
        handler.do_GET()

    out = capsys.readouterr()
    assert secret not in caplog.text
    assert secret not in out.out + out.err
