"""
Data quality check framework.

Usage:
    from health_data_hub.quality.checks import CheckRunner
    from health_data_hub.quality.checks_health import build_runner

    runner = build_runner(conn)
    report = runner.run_all()
    if report.has_errors:
        raise RuntimeError(f"{report.error_count} quality checks failed")

Standalone:
    python -m health_data_hub.quality.run_checks
"""

from __future__ import annotations

import logging
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class CheckResult:
    check_name: str
    severity: str          # "warn" or "error"
    passed: bool
    message: str
    rows_affected: int = 0


@dataclass
class QualityReport:
    run_id: str
    run_at: datetime
    results: list[CheckResult] = field(default_factory=list)

    @property
    def has_failures(self) -> bool:
        return any(not r.passed for r in self.results)

    @property
    def has_errors(self) -> bool:
        return any(not r.passed and r.severity == "error" for r in self.results)

    @property
    def error_count(self) -> int:
        return sum(1 for r in self.results if not r.passed and r.severity == "error")

    @property
    def warn_count(self) -> int:
        return sum(1 for r in self.results if not r.passed and r.severity == "warn")


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------

class DataQualityCheck(ABC):
    def __init__(self, check_name: str, description: str, severity: str = "error"):
        assert severity in ("warn", "error"), f"severity must be 'warn' or 'error', got {severity!r}"
        self.check_name = check_name
        self.description = description
        self.severity = severity

    @abstractmethod
    def run(self, conn) -> CheckResult:
        ...

    def _pass(self, message: str, rows_affected: int = 0) -> CheckResult:
        return CheckResult(self.check_name, self.severity, True, message, rows_affected)

    def _fail(self, message: str, rows_affected: int = 0) -> CheckResult:
        return CheckResult(self.check_name, self.severity, False, message, rows_affected)


# ---------------------------------------------------------------------------
# Concrete check types
# ---------------------------------------------------------------------------

class RowCountCheck(DataQualityCheck):
    """Assert a table has between min_rows and max_rows rows."""

    def __init__(self, table: str, min_rows: int, max_rows: Optional[int] = None,
                 severity: str = "error"):
        name = f"row_count_{table}"
        desc = f"{table}: between {min_rows} and {max_rows or '∞'} rows"
        super().__init__(name, desc, severity)
        self.table = table
        self.min_rows = min_rows
        self.max_rows = max_rows

    def run(self, conn) -> CheckResult:
        with conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) FROM {self.table}")
            count = cur.fetchone()[0]

        if count < self.min_rows:
            return self._fail(f"{self.table} has {count} rows (min {self.min_rows})", count)
        if self.max_rows is not None and count > self.max_rows:
            return self._fail(f"{self.table} has {count} rows (max {self.max_rows})", count)
        return self._pass(f"{self.table} has {count} rows", count)


class ValueRangeCheck(DataQualityCheck):
    """Assert all non-null values in a column fall within [min_val, max_val]."""

    def __init__(self, table: str, column: str, min_val: float, max_val: float,
                 where_clause: Optional[str] = None, severity: str = "error"):
        name = f"value_range_{table}_{column}"
        desc = f"{table}.{column} in [{min_val}, {max_val}]"
        super().__init__(name, desc, severity)
        self.table = table
        self.column = column
        self.min_val = min_val
        self.max_val = max_val
        self.where_clause = where_clause

    def run(self, conn) -> CheckResult:
        where = f"WHERE {self.where_clause}" if self.where_clause else "WHERE TRUE"
        sql = f"""
            SELECT COUNT(*) FROM {self.table}
            {where}
              AND {self.column} IS NOT NULL
              AND ({self.column} < %s OR {self.column} > %s)
        """
        with conn.cursor() as cur:
            cur.execute(sql, (self.min_val, self.max_val))
            out_of_range = cur.fetchone()[0]

        if out_of_range > 0:
            return self._fail(
                f"{self.table}.{self.column}: {out_of_range} rows outside [{self.min_val}, {self.max_val}]",
                out_of_range,
            )
        return self._pass(f"{self.table}.{self.column} all in range [{self.min_val}, {self.max_val}]")


class FreshnessCheck(DataQualityCheck):
    """Assert the most recent timestamp in a column is within max_age_minutes."""

    def __init__(self, table: str, timestamp_column: str, max_age_minutes: int,
                 severity: str = "error"):
        name = f"freshness_{table}"
        desc = f"{table}.{timestamp_column} updated within {max_age_minutes}m"
        super().__init__(name, desc, severity)
        self.table = table
        self.timestamp_column = timestamp_column
        self.max_age_minutes = max_age_minutes

    def run(self, conn) -> CheckResult:
        sql = f"SELECT MAX({self.timestamp_column}) FROM {self.table}"
        with conn.cursor() as cur:
            cur.execute(sql)
            row = cur.fetchone()

        latest = row[0] if row else None

        if latest is None:
            return self._fail(f"{self.table} has no rows — freshness unknown")

        # Make both tz-aware for comparison
        now = datetime.now(timezone.utc)
        if latest.tzinfo is None:
            latest = latest.replace(tzinfo=timezone.utc)

        age_minutes = (now - latest).total_seconds() / 60
        if age_minutes > self.max_age_minutes:
            return self._fail(
                f"{self.table} last updated {age_minutes:.0f}m ago (max {self.max_age_minutes}m)",
                rows_affected=1,
            )
        return self._pass(f"{self.table} last updated {age_minutes:.0f}m ago")


class NullCheck(DataQualityCheck):
    """Assert the null percentage in a column does not exceed max_null_pct."""

    def __init__(self, table: str, column: str, max_null_pct: float = 0.0,
                 severity: str = "error"):
        name = f"null_check_{table}_{column}"
        desc = f"{table}.{column} null% <= {max_null_pct:.0%}"
        super().__init__(name, desc, severity)
        self.table = table
        self.column = column
        self.max_null_pct = max_null_pct

    def run(self, conn) -> CheckResult:
        sql = f"""
            SELECT
                COUNT(*) FILTER (WHERE {self.column} IS NULL) AS nulls,
                COUNT(*) AS total
            FROM {self.table}
        """
        with conn.cursor() as cur:
            cur.execute(sql)
            nulls, total = cur.fetchone()

        if total == 0:
            return self._pass(f"{self.table}.{self.column} — table empty, skipping null check")

        pct = nulls / total
        if pct > self.max_null_pct:
            return self._fail(
                f"{self.table}.{self.column}: {nulls}/{total} nulls ({pct:.1%}, max {self.max_null_pct:.0%})",
                nulls,
            )
        return self._pass(f"{self.table}.{self.column}: {nulls}/{total} nulls ({pct:.1%})")


class SchemaCheck(DataQualityCheck):
    """Assert that expected columns exist in a table with the right data types."""

    def __init__(self, table: str, expected_columns: dict[str, str], severity: str = "error"):
        name = f"schema_{table}"
        desc = f"{table}: expected columns present with correct types"
        super().__init__(name, desc, severity)
        self.table = table
        self.expected_columns = {k.lower(): v.lower() for k, v in expected_columns.items()}

    def run(self, conn) -> CheckResult:
        # table may be schema-qualified (e.g. "monitoring.quality_check_runs")
        parts = self.table.split(".")
        schema = parts[0] if len(parts) == 2 else "public"
        tbl    = parts[1] if len(parts) == 2 else parts[0]

        sql = """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
        """
        with conn.cursor() as cur:
            cur.execute(sql, (schema, tbl))
            actual = {row[0].lower(): row[1].lower() for row in cur.fetchall()}

        missing  = [c for c in self.expected_columns if c not in actual]
        wrong_type = [
            f"{c} (expected {self.expected_columns[c]}, got {actual[c]})"
            for c in self.expected_columns
            if c in actual and self.expected_columns[c] not in actual[c]
        ]

        issues = missing + wrong_type
        if issues:
            return self._fail(
                f"{self.table} schema issues: {', '.join(issues)}",
                len(issues),
            )
        return self._pass(f"{self.table}: all {len(self.expected_columns)} expected columns present")


class AnomalyCheck(DataQualityCheck):
    """
    Alert if today's row count for a table is more than z_score_threshold
    standard deviations from the lookback_days mean.

    A min_baseline_stddev floor prevents false positives during rest periods
    (e.g. zero-workout days that trigger as anomalies against a training week).
    """

    def __init__(self, table: str, metric_column: str, date_column: str = "created_at",
                 lookback_days: int = 7, z_score_threshold: float = 3.0,
                 min_baseline_stddev: float = 0.5, severity: str = "warn"):
        name = f"anomaly_{table}_{metric_column}"
        desc = (
            f"{table}.{metric_column}: today not >{z_score_threshold}σ "
            f"from {lookback_days}-day baseline"
        )
        super().__init__(name, desc, severity)
        self.table = table
        self.metric_column = metric_column
        self.date_column = date_column
        self.lookback_days = lookback_days
        self.z_score_threshold = z_score_threshold
        self.min_baseline_stddev = min_baseline_stddev

    def run(self, conn) -> CheckResult:
        sql = f"""
            WITH daily_counts AS (
                SELECT
                    DATE({self.date_column}) AS day,
                    COUNT({self.metric_column}) AS cnt
                FROM {self.table}
                WHERE {self.date_column} >= CURRENT_DATE - INTERVAL '{self.lookback_days + 1} days'
                GROUP BY 1
            ),
            baseline AS (
                SELECT AVG(cnt) AS mean, STDDEV(cnt) AS stddev
                FROM daily_counts
                WHERE day < CURRENT_DATE
            ),
            today AS (
                SELECT cnt FROM daily_counts WHERE day = CURRENT_DATE
            )
            SELECT
                today.cnt,
                baseline.mean,
                -- Floor stddev to avoid false positives during rest/low-variance periods
                GREATEST(baseline.stddev, %s) AS stddev
            FROM today, baseline
        """
        with conn.cursor() as cur:
            cur.execute(sql, (self.min_baseline_stddev,))
            row = cur.fetchone()

        if row is None or row[1] is None:
            return self._pass(f"{self.table}: insufficient baseline data, skipping anomaly check")

        today_cnt, mean, stddev = row
        z = abs((today_cnt - mean) / stddev) if stddev else 0

        if z > self.z_score_threshold:
            return self._fail(
                f"{self.table}.{self.metric_column}: today={today_cnt}, "
                f"baseline mean={mean:.1f} σ={stddev:.2f}, z={z:.2f} (threshold {self.z_score_threshold})",
                rows_affected=today_cnt,
            )
        return self._pass(
            f"{self.table}.{self.metric_column}: today={today_cnt}, "
            f"baseline mean={mean:.1f} σ={stddev:.2f}, z={z:.2f}"
        )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

class CheckRunner:
    def __init__(self, checks: list[DataQualityCheck], source: str = "all"):
        self.checks = checks
        self.source = source

    def run_all(self, conn) -> QualityReport:
        report = QualityReport(
            run_id=str(uuid.uuid4()),
            run_at=datetime.now(timezone.utc),
        )
        for check in self.checks:
            try:
                result = check.run(conn)
            except Exception as exc:
                logger.exception("Check %s raised unexpectedly", check.check_name)
                result = CheckResult(
                    check_name=check.check_name,
                    severity=check.severity,
                    passed=False,
                    message=f"Check raised exception: {exc}",
                )
            report.results.append(result)
            level = logging.WARNING if not result.passed else logging.DEBUG
            logger.log(level, "[quality] %s %s — %s",
                       "FAIL" if not result.passed else "PASS",
                       result.check_name, result.message)
        return report
