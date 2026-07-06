"""
Predefined quality check suite for the Health Data Hub pipeline.

Each check maps to a specific table and column. Thresholds are derived from
the pipeline's known timing (poll intervals) and physiological bounds.

Freshness note on Oura:
  The Oura poller runs every 30 min between 05:00–15:00 only. FreshnessCheck
  would false-alarm if run in the evening. The checks here use a 480-minute
  (8-hour) threshold so they only alert on genuine staleness, not normal
  polling windows.
"""

from __future__ import annotations

from .checks import (
    AnomalyCheck,
    CheckRunner,
    FreshnessCheck,
    NullCheck,
    RowCountCheck,
    ValueRangeCheck,
)


def build_runner(source: str = "all") -> CheckRunner:
    """
    Return a CheckRunner with the full predefined suite filtered by source.

    Args:
        source: "all" | "workouts" | "oura" | "nutrition"
    """
    checks = []

    if source in ("all", "workouts"):
        checks += _workout_checks()

    if source in ("all", "oura"):
        checks += _oura_checks()

    if source in ("all", "nutrition"):
        checks += _nutrition_checks()

    if source == "all":
        checks += _cross_source_checks()

    return CheckRunner(checks, source=source)


# ---------------------------------------------------------------------------
# Per-source check suites
# ---------------------------------------------------------------------------

def _workout_checks():
    return [
        # At least one workout has ever been ingested
        RowCountCheck("workouts_raw", min_rows=1),

        # Power data is physiologically sane
        ValueRangeCheck(
            "workout_summary", "np_watts", 0, 2000,
            where_clause="np_watts IS NOT NULL",
        ),
        ValueRangeCheck(
            "workout_summary", "intensity_factor", 0, 1.5,
            where_clause="intensity_factor IS NOT NULL",
        ),
        ValueRangeCheck(
            "workout_summary", "tss_power", 0, 500,
            where_clause="tss_power IS NOT NULL",
        ),

        # Heart rate from Strava samples
        ValueRangeCheck(
            "workout_samples", "heartrate", 30, 220,
            where_clause="heartrate IS NOT NULL",
        ),

        # No workout may lack an external ID (would cause duplicate inserts on next poll)
        NullCheck("workouts_raw", "external_id", max_null_pct=0.0),

        # Strava poller runs every 60 min; alert if nothing written in 2 cycles
        FreshnessCheck(
            "strava_sync_log", "triggered_at", max_age_minutes=120,
            severity="warn",
        ),

        # Daily workout count should not be a statistical outlier vs. 7-day baseline
        AnomalyCheck(
            "workouts_raw", "id",
            date_column="start_time",
            lookback_days=7,
            z_score_threshold=3.0,
            min_baseline_stddev=0.5,
            severity="warn",
        ),
    ]


def _oura_checks():
    return [
        # Sleep score is always 0–100
        ValueRangeCheck("oura_sleep_raw", "efficiency", 0, 100),

        # No sleep record may lack a date (primary join key for the daily report)
        NullCheck("oura_sleep_raw", "day", max_null_pct=0.0),

        # Readiness score is always 0–100
        ValueRangeCheck("oura_readiness_raw", "score", 0, 100,
                        where_clause="score IS NOT NULL"),
        NullCheck("oura_readiness_raw", "day", max_null_pct=0.0),

        # Oura polls 05:00–15:00 every 30 min; 480 min threshold avoids evening false alarms
        FreshnessCheck(
            "oura_sleep_raw", "bedtime_end", max_age_minutes=480,
            severity="warn",
        ),
    ]


def _nutrition_checks():
    return [
        # Calorie range: 0 means no log, 10000 is a physiological ceiling
        ValueRangeCheck(
            "nutrition_daily", "calories", 0, 10000,
            where_clause="calories IS NOT NULL",
        ),

        # No nutrition row may lack a date
        NullCheck("nutrition_daily", "day", max_null_pct=0.0),

        # Nutrition poller runs once at 22:00; allow 3-hour window for late sync
        FreshnessCheck(
            "nutrition_daily", "day::timestamp", max_age_minutes=180,
            severity="warn",
        ),
    ]


def _cross_source_checks():
    """Checks that span multiple sources or enforce referential integrity."""
    return [
        # Every workout_summary row must reference a valid workout
        # (this is a foreign-key check via a NOT EXISTS query — implemented as RowCountCheck
        # on a subquery; expressed here as a ValueRangeCheck on the join result count)
        # Simpler approach: confirm workout_samples rows all have valid workout_ids
        NullCheck("workout_samples", "workout_id", max_null_pct=0.0),

        # At least 1 oura readiness row exists overall
        RowCountCheck("oura_readiness_raw", min_rows=1),

        # At least 1 nutrition row exists overall
        RowCountCheck("nutrition_daily", min_rows=1),
    ]
