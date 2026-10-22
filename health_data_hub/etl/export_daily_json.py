"""
Daily health data export — joins all sources into one JSON object per day.

Usage:
    from health_data_hub.etl.export_daily_json import export_daily_json
    rows = export_daily_json(date(2026, 3, 10), date(2026, 3, 16))

    # Or as a CLI script:
    python -m health_data_hub.etl.export_daily_json 2026-03-10 2026-03-16
"""

from __future__ import annotations

import json
import sys
from datetime import date

import psycopg2
import psycopg2.extras

from health_data_hub.config.settings import DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
from health_data_hub.utils.db_connect import get_connection


_QUERY = """
WITH RECURSIVE date_series AS (
    SELECT generate_series(%(start_date)s::date, %(end_date)s::date, interval '1 day')::date AS day
),
sleep AS (
    -- One row per day: primary (long_sleep) session only.
    -- Oura also stores naps under the same day with type='sleep'; excluding them
    -- prevents duplicate day rows in the join.
    SELECT
        day,
        efficiency,
        total_sleep_sec,
        rem_sleep_sec,
        deep_sleep_sec,
        light_sleep_sec,
        awake_sec,
        latency_sec,
        restless_periods,
        lowest_hr,
        avg_hr  AS sleep_avg_hr,
        avg_hrv AS sleep_avg_hrv,
        avg_breath,
        sleep_id
    FROM oura_sleep_raw
    WHERE day BETWEEN %(start_date)s AND %(end_date)s
      AND raw_json->>'type' = 'long_sleep'
),
readiness AS (
    SELECT
        day,
        score          AS readiness_score,
        temp_dev,
        temp_trend_dev,
        r_hrv_balance,
        r_recovery_index,
        r_resting_hr,
        r_sleep_balance,
        r_activity_balance,
        r_prev_night
    FROM oura_readiness_raw
    WHERE day BETWEEN %(start_date)s AND %(end_date)s
),
activity AS (
    SELECT
        day,
        steps,
        cal_total,
        cal_active,
        inactive_sec,
        low_activity_sec,
        medium_activity_sec,
        high_activity_sec,
        met_min_low,
        met_min_medium,
        met_min_high
    FROM oura_activity_raw
    WHERE day BETWEEN %(start_date)s AND %(end_date)s
),
hr_agg AS (
    -- Aggregate per-minute BPM and HRV samples for each primary sleep session.
    -- bpm and hrv_rmssd are stored in separate rows (same sleep_id, different
    -- timestamps) due to how Oura interleaves the two streams; AVG ignores NULLs
    -- so each aggregate correctly reflects only the rows that carry that metric.
    SELECT
        s.sleep_id,
        ROUND(AVG(h.bpm)::numeric,      1) AS avg_overnight_bpm,
        ROUND(MIN(h.bpm)::numeric,      1) AS min_overnight_bpm,
        ROUND(AVG(h.hrv_rmssd)::numeric, 1) AS avg_hrv_rmssd
    FROM oura_hr_samples h
    JOIN sleep s ON h.sleep_id = s.sleep_id
    GROUP BY s.sleep_id
),
workouts AS (
    -- Use DATE(start_time) directly: start_time is stored as timestamp WITHOUT
    -- time zone already in the user's local time (America/Los_Angeles), so
    -- applying AT TIME ZONE 'UTC' would mis-bucket late-night sessions.
    SELECT
        DATE(start_time) AS day,
        json_agg(json_build_object(
            'workout_id',      workout_id,
            'title',           title,
            'sport_type',      sport_type,
            'start_time',      start_time,
            'duration_s',      moving_s,
            'distance_m',      distance_m,
            'avg_hr',          avg_hr,
            'max_hr',          max_hr,
            'avg_watts',       avg_watts,
            'np_watts',        np_watts,
            'intensity_factor', intensity_factor,
            'tss',             tss_power,
            'kj',              kj,
            'elevation_m',     total_elevation_gain
        ) ORDER BY start_time) AS workouts
    FROM workout_summary
    WHERE DATE(start_time) BETWEEN %(start_date)s AND %(end_date)s
    GROUP BY DATE(start_time)
),
phys AS (
    SELECT
        day,
        overall_state,
        energy_level,
        body_signals,
        notes           AS subjective_notes,
        entry_confidence
    FROM daily_physical_state
    WHERE day BETWEEN %(start_date)s AND %(end_date)s
),
nutrition AS (
    SELECT
        day,
        calories,
        protein_g,
        carbs_g,
        fat_g,
        fiber_g,
        sugar_g,
        sodium_mg,
        goal_calories,
        logged_complete,
        weight_kg
    FROM nutrition_daily
    WHERE day BETWEEN %(start_date)s AND %(end_date)s
),
body AS (
    SELECT day, weight_kg
    FROM body_weight_daily
    WHERE day BETWEEN %(start_date)s AND %(end_date)s
),
planned AS (
    SELECT
        planned_date AS day,
        json_agg(json_build_object(
            'class_type',    pw.class_type,
            'duration_min',  pw.duration_min,
            'estimated_tss', pw.estimated_tss,
            'notes',         pw.notes
        ) ORDER BY pw.id) AS planned_workouts
    FROM planned_workouts pw
    WHERE planned_date BETWEEN %(start_date)s AND %(end_date)s
    GROUP BY planned_date
),
daily_tss_lookback AS (
    -- Generate a date series from 42 days before start_date through end_date,
    -- then left-join workout_summary to sum TSS per day (rest days get 0).
    SELECT
        gs.day,
        COALESCE(SUM(ws.tss_power), 0.0) AS daily_tss
    FROM generate_series(
        %(start_date)s::date - interval '42 days',
        %(end_date)s::date,
        interval '1 day'
    ) AS gs(day)
    LEFT JOIN workout_summary ws ON DATE(ws.start_time) = gs.day
    GROUP BY gs.day
),
ema_calc AS (
    -- Recursive CTE: seed with the first lookback day, then iterate forward
    -- computing CTL (42-day EMA) and ATL (7-day EMA).
    SELECT
        day,
        daily_tss,
        daily_tss AS ctl,
        daily_tss AS atl
    FROM daily_tss_lookback
    WHERE day = %(start_date)s::date - interval '42 days'

    UNION ALL

    SELECT
        tl.day,
        tl.daily_tss,
        ec.ctl + (tl.daily_tss - ec.ctl) / 42.0 AS ctl,
        ec.atl + (tl.daily_tss - ec.atl) / 7.0  AS atl
    FROM ema_calc ec
    JOIN daily_tss_lookback tl ON tl.day = ec.day + interval '1 day'
),
pmc AS (
    -- Filter to the export window and compute TSB = CTL - ATL.
    SELECT
        day,
        ROUND(ctl::numeric, 1) AS ctl,
        ROUND(atl::numeric, 1) AS atl,
        ROUND((ctl - atl)::numeric, 1) AS tsb
    FROM ema_calc
    WHERE day BETWEEN %(start_date)s AND %(end_date)s
)
SELECT
    d.day,
    json_build_object(
        'efficiency',       sl.efficiency,
        'total_sleep_sec',  sl.total_sleep_sec,
        'rem_sec',          sl.rem_sleep_sec,
        'deep_sec',         sl.deep_sleep_sec,
        'light_sec',        sl.light_sleep_sec,
        'awake_sec',        sl.awake_sec,
        'latency_sec',      sl.latency_sec,
        'restless_periods', sl.restless_periods,
        'lowest_hr',        sl.lowest_hr,
        'avg_hr',           sl.sleep_avg_hr,
        'avg_hrv',          sl.sleep_avg_hrv,
        'avg_breath',       sl.avg_breath
    ) AS sleep,
    json_build_object(
        'score',               re.readiness_score,
        'temp_dev',            re.temp_dev,
        'r_hrv_balance',       re.r_hrv_balance,
        'r_recovery_index',    re.r_recovery_index,
        'r_resting_hr',        re.r_resting_hr,
        'r_sleep_balance',     re.r_sleep_balance,
        'r_activity_balance',  re.r_activity_balance,
        'r_prev_night',        re.r_prev_night
    ) AS readiness,
    json_build_object(
        'steps',               ac.steps,
        'cal_total',           ac.cal_total,
        'cal_active',          ac.cal_active,
        'inactive_sec',        ac.inactive_sec,
        'low_activity_sec',    ac.low_activity_sec,
        'medium_activity_sec', ac.medium_activity_sec,
        'high_activity_sec',   ac.high_activity_sec,
        'met_min_low',         ac.met_min_low,
        'met_min_medium',      ac.met_min_medium,
        'met_min_high',        ac.met_min_high
    ) AS activity,
    json_build_object(
        'avg_overnight_bpm', hr.avg_overnight_bpm,
        'min_overnight_bpm', hr.min_overnight_bpm,
        'avg_hrv_rmssd',     hr.avg_hrv_rmssd
    ) AS hr_overnight,
    COALESCE(wo.workouts, '[]'::json) AS workouts,
    json_build_object(
        'overall_state',   ph.overall_state,
        'energy_level',    ph.energy_level,
        'body_signals',    ph.body_signals,
        'notes',           ph.subjective_notes,
        'entry_confidence', ph.entry_confidence
    ) AS physical_state,
    json_build_object(
        'calories',       nu.calories,
        'protein_g',      nu.protein_g,
        'carbs_g',        nu.carbs_g,
        'fat_g',          nu.fat_g,
        'fiber_g',        nu.fiber_g,
        'sugar_g',        nu.sugar_g,
        'sodium_mg',      nu.sodium_mg,
        'goal_calories',  nu.goal_calories,
        'logged_complete', nu.logged_complete,
        'weight_kg',      COALESCE(bw.weight_kg, nu.weight_kg)
    ) AS nutrition,
    json_build_object('ctl', pm.ctl, 'atl', pm.atl, 'tsb', pm.tsb) AS performance_management,
    COALESCE(pl.planned_workouts, '[]'::json) AS planned_workouts
FROM date_series d
LEFT JOIN sleep       sl ON sl.day      = d.day
LEFT JOIN readiness   re ON re.day      = d.day
LEFT JOIN activity    ac ON ac.day      = d.day
LEFT JOIN hr_agg      hr ON hr.sleep_id = sl.sleep_id
LEFT JOIN workouts    wo ON wo.day      = d.day
LEFT JOIN phys        ph ON ph.day      = d.day
LEFT JOIN nutrition   nu ON nu.day      = d.day
LEFT JOIN body        bw ON bw.day      = d.day
LEFT JOIN pmc         pm ON pm.day      = d.day
LEFT JOIN planned     pl ON pl.day      = d.day
ORDER BY d.day DESC;
"""


def _default(obj):
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    raise TypeError(f"Not JSON serializable: {type(obj)}")


def export_daily_json(start_date: date, end_date: date) -> dict:
    """Return a dict with 'days' (per-day rows) and 'window_summary' (PMC summary)."""
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(_QUERY, {"start_date": start_date, "end_date": end_date})
            rows = cur.fetchall()
    finally:
        conn.close()

    days = json.loads(json.dumps([dict(r) for r in rows], default=_default))

    pmc_rows = [r for r in days if r.get("performance_management", {}).get("ctl") is not None]
    if pmc_rows:
        # rows are ORDER BY day DESC, so pmc_rows[0] is most recent, pmc_rows[-1] is oldest
        window_summary = {
            "ctl_start":   pmc_rows[-1]["performance_management"]["ctl"],
            "ctl_end":     pmc_rows[0]["performance_management"]["ctl"],
            "ctl_change":  round(pmc_rows[0]["performance_management"]["ctl"] - pmc_rows[-1]["performance_management"]["ctl"], 1),
            "tsb_min":     min(p["performance_management"]["tsb"] for p in pmc_rows),
            "tsb_max":     max(p["performance_management"]["tsb"] for p in pmc_rows),
            "tsb_current": pmc_rows[0]["performance_management"]["tsb"],
        }
    else:
        window_summary = None

    return {"days": days, "window_summary": window_summary}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python -m health_data_hub.etl.export_daily_json YYYY-MM-DD YYYY-MM-DD")
        sys.exit(1)
    start = date.fromisoformat(sys.argv[1])
    end = date.fromisoformat(sys.argv[2])
    result = export_daily_json(start, end)
    print(json.dumps(result, indent=2))
