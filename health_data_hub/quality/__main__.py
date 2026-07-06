"""
Standalone CLI for running data quality checks.

Usage:
    python -m health_data_hub.quality.run_checks
    python -m health_data_hub.quality.run_checks --source workouts
    python -m health_data_hub.quality.run_checks --source oura --fail-fast
    python -m health_data_hub.quality.run_checks --source all

Exit codes:
    0 — all checks passed (or only warnings)
    1 — one or more error-severity checks failed
    2 — unexpected exception
"""

from __future__ import annotations

import argparse
import logging
import sys

from health_data_hub.utils.db_connect import get_connection
from health_data_hub.utils.logging_config import setup_logging

from .alerts import send_quality_alert
from .checks_health import build_runner
from .storage import save_report

VALID_SOURCES = ("all", "workouts", "oura", "nutrition")


def main() -> int:
    setup_logging()
    logger = logging.getLogger(__name__)

    parser = argparse.ArgumentParser(description="Run health data quality checks")
    parser.add_argument(
        "--source",
        choices=VALID_SOURCES,
        default="all",
        help="Which source group to check (default: all)",
    )
    parser.add_argument(
        "--fail-fast",
        action="store_true",
        help="Stop after the first error-severity failure",
    )
    args = parser.parse_args()

    try:
        conn = get_connection()
    except Exception as exc:
        logger.error("Cannot connect to database: %s", exc)
        return 2

    runner = build_runner(source=args.source)

    if args.fail_fast:
        # Wrap run_all to short-circuit on first error
        from health_data_hub.quality.checks import QualityReport
        import uuid
        from datetime import datetime, timezone

        report = QualityReport(run_id=str(uuid.uuid4()), run_at=datetime.now(timezone.utc))
        for check in runner.checks:
            result = check.run(conn)
            report.results.append(result)
            if not result.passed and result.severity == "error":
                logger.error("[quality] fail-fast: stopping after %s", check.check_name)
                break
    else:
        report = runner.run_all(conn)

    save_report(conn, report)
    send_quality_alert(report)
    conn.close()

    # Summary line
    status = "ERROR" if report.has_errors else ("WARN" if report.has_failures else "PASS")
    print(
        f"[quality] {status} — "
        f"{len(report.results)} checks, "
        f"{report.error_count} errors, "
        f"{report.warn_count} warnings"
    )

    return 1 if report.has_errors else 0


if __name__ == "__main__":
    sys.exit(main())
