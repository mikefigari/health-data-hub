"""
Persist QualityReport results to monitoring.quality_check_runs.

Schema is created on first use (CREATE TABLE IF NOT EXISTS), so no manual
migration is required — just run the checks and the table appears.

Trend queries:
    SELECT check_name, COUNT(*) FILTER (WHERE NOT passed) AS failures,
           COUNT(*) AS total_runs
    FROM monitoring.quality_check_runs
    WHERE run_at > NOW() - INTERVAL '7 days'
    GROUP BY check_name
    ORDER BY failures DESC;
"""

from __future__ import annotations

import logging

from .checks import QualityReport

logger = logging.getLogger(__name__)

_CREATE_SCHEMA = "CREATE SCHEMA IF NOT EXISTS monitoring"

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS monitoring.quality_check_runs (
    id            SERIAL PRIMARY KEY,
    run_id        UUID        NOT NULL,
    run_at        TIMESTAMPTZ NOT NULL,
    check_name    TEXT        NOT NULL,
    severity      TEXT        NOT NULL,
    passed        BOOLEAN     NOT NULL,
    message       TEXT,
    rows_affected INT         DEFAULT 0
)
"""

_INSERT = """
INSERT INTO monitoring.quality_check_runs
    (run_id, run_at, check_name, severity, passed, message, rows_affected)
VALUES (%s, %s, %s, %s, %s, %s, %s)
"""


def save_report(conn, report: QualityReport) -> None:
    """Write every CheckResult in report to monitoring.quality_check_runs."""
    with conn.cursor() as cur:
        cur.execute(_CREATE_SCHEMA)
        cur.execute(_CREATE_TABLE)
        for result in report.results:
            cur.execute(_INSERT, (
                report.run_id,
                report.run_at,
                result.check_name,
                result.severity,
                result.passed,
                result.message,
                result.rows_affected,
            ))
    conn.commit()
    logger.info(
        "[quality] saved %d results for run %s (%d errors, %d warnings)",
        len(report.results),
        report.run_id,
        report.error_count,
        report.warn_count,
    )
