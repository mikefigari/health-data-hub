"""
Quality alert sender.

Wraps the existing health_data_hub.utils.alert.send_alert() so quality
failures use the same email transport and cooldown logic as Strava auth alerts.

Only fires if report.has_failures — call unconditionally after every run.
"""

from __future__ import annotations

from .checks import QualityReport
from health_data_hub.utils.alert import send_alert


def send_quality_alert(report: QualityReport) -> None:
    """Send an email alert summarising failed checks. No-op if all passed."""
    if not report.has_failures:
        return

    errors  = [r for r in report.results if not r.passed and r.severity == "error"]
    warns   = [r for r in report.results if not r.passed and r.severity == "warn"]

    lines = [
        f"Quality run {report.run_id} at {report.run_at.strftime('%Y-%m-%d %H:%M UTC')}",
        f"Result: {'ERROR' if report.has_errors else 'WARN'} — "
        f"{report.error_count} error(s), {report.warn_count} warning(s)",
        "",
    ]

    if errors:
        lines.append("ERRORS (will block downstream tasks):")
        for r in errors:
            lines.append(f"  ✗ {r.check_name}: {r.message}")
        lines.append("")

    if warns:
        lines.append("WARNINGS (informational only):")
        for r in warns:
            lines.append(f"  ! {r.check_name}: {r.message}")

    subject = (
        f"[quality] {'ERROR' if report.has_errors else 'WARN'} — "
        f"{report.error_count} error(s), {report.warn_count} warning(s)"
    )
    send_alert(subject, "\n".join(lines))
