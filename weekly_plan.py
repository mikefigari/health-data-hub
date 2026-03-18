#!/usr/bin/env python
"""
weekly_plan.py — Weekly data review via Claude.

Surfaces trends in weight, fatigue, and nutrition adherence over the past
7 days and the prior 90 days. No scheduling — the athlete reviews the data
and makes their own decisions for the week ahead.

Usage:
    python weekly_plan.py [--no-save]

Flags:
    --no-save   Print to terminal only; do not write to analysis_logs/
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import psycopg2
import psycopg2.extras
import anthropic

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from health_data_hub.etl.export_daily_json import export_daily_json
from health_data_hub.utils.db_connect import get_connection

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LOGS_DIR = PROJECT_ROOT / "analysis_logs"

TDEE_BASELINE = 2800          # kcal rest day. Update as weight drops.
WORKOUT_KCAL_PER_TSS = 4      # estimated kcal burn per TSS point

SYSTEM_PROMPT = """\
You are a weekly data analyst for an endurance athlete losing 27kg while
preserving cycling power (w/kg). You surface what the data shows — you do not
prescribe training. The athlete controls all workout decisions.

Your job is to give an honest, specific account of how the past week went across
three dimensions: fatigue and recovery, nutrition adherence, and weight/power
progress. Surface patterns the athlete might not have noticed. Call out what the
data actually shows without sugarcoating.

Fatigue context:
- TSB is the balance between chronic load (CTL) and acute load (ATL)
- TSB below -20 during a caloric deficit is a compounded stress signal — the body
  is under both training and nutritional pressure simultaneously
- Poor sleep (avg Oura score < 70 over 7 days) adds a third stressor — flag this
  combination explicitly if present
- The athlete records a daily physical state — use this to validate or question
  what the objective metrics show

Weight loss context:
- Goal is 27kg loss while preserving w/kg
- A week where weight dropped AND w/kg held or improved is a win — say so
- A week where weight dropped BUT power metrics suggest fatigue is accumulating
  is a warning sign — the deficit may be too aggressive
- A week where weight stalled despite apparent deficit adherence may indicate
  cortisol-driven water retention from poor sleep or high ATL — flag the
  most likely cause based on the data

You will receive:
- LAST_14_DAYS: full export including PMC, weight, nutrition, workouts,
  physical_state per day
- QUARTER_SUMMARY: window_summary from last 90 days (CTL trend, TSB range)
- DEFICIT_ADHERENCE: days on target, avg deficit, missed days with direction
- PLANNED_NEXT_WEEK: athlete's planned classes (context only — not for evaluation)

Respond in this exact structure:

## Week in numbers
CTL start/end, TSB current, avg sleep score, avg deficit, weight change.
Just the numbers — one line each.

## Recovery and fatigue
What do the combined signals say about how the body handled last week's load?
Use Oura data, TSB, and physical state recordings together. Flag any pattern
across multiple days (e.g. physical state poor on high-TSS days, sleep degrading
mid-week). Two to three sentences.

## Nutrition
Honest account of deficit adherence. Where did it break down if it did —
which days, over or under? What does the 3-day protein trend look like?
If adherence was good, confirm it clearly.

## Weight and w/kg trend
This week's weight change. Current w/kg estimate. Whether the 90-day direction
is tracking toward the goal. Flag if weight loss is outpacing power preservation
or vice versa — be specific about what the numbers suggest.

## What the data is saying
One paragraph. Synthesise all three dimensions into the single most important
signal from this week's data. This is an observation, not an instruction.\
"""


# ---------------------------------------------------------------------------
# Deficit adherence computation
# ---------------------------------------------------------------------------

def _compute_deficit_adherence(days_14: list[dict]) -> dict:
    """
    Compute deficit adherence for the last 7 days from the 14-day export.
    Returns a summary dict and a printable string.
    """
    today = date.today()
    last_7_start = (today - timedelta(days=6)).isoformat()

    last_7 = [d for d in days_14 if d.get("day") >= last_7_start]
    # Sort ascending
    last_7 = sorted(last_7, key=lambda d: d.get("day", ""))

    results = []
    for row in last_7:
        nutrition = row.get("nutrition") or {}
        pmc = row.get("performance_management") or {}
        workouts = row.get("workouts") or []

        calories = nutrition.get("calories")

        # Sum TSS from actual workouts that day
        day_tss = sum(
            (w.get("tss") or 0)
            for w in workouts
            if isinstance(w, dict)
        )

        estimated_tdee = TDEE_BASELINE + (day_tss * WORKOUT_KCAL_PER_TSS)

        if calories is not None:
            actual_deficit = estimated_tdee - calories
            on_target = 400 <= actual_deficit <= 800
        else:
            actual_deficit = None
            on_target = False

        results.append({
            "date":           row.get("day"),
            "calories":       calories,
            "day_tss":        day_tss,
            "estimated_tdee": estimated_tdee,
            "actual_deficit": actual_deficit,
            "on_target":      on_target,
        })

    days_on_target = sum(1 for r in results if r["on_target"])
    valid_deficits = [r["actual_deficit"] for r in results if r["actual_deficit"] is not None]
    avg_deficit = round(sum(valid_deficits) / len(valid_deficits), 0) if valid_deficits else None

    missed = []
    for r in results:
        if not r["on_target"]:
            d = r["actual_deficit"]
            if d is None:
                direction = "no data"
            elif d < 400:
                direction = "under-deficit" if d >= 0 else f"surplus ({abs(int(d))} kcal over TDEE)"
            else:
                direction = "over-deficit"
            missed.append({"date": r["date"], "direction": direction, "deficit": d})

    summary = {
        "days_on_target": days_on_target,
        "total_days_with_data": len(valid_deficits),
        "avg_deficit": avg_deficit,
        "missed": missed,
        "detail": results,
    }

    # Printable version
    lines = [
        "",
        "--- DEFICIT ADHERENCE (last 7 days) ---",
        f"  Days on target (400-800 kcal deficit): {days_on_target}/7",
        f"  Avg deficit: {avg_deficit} kcal" if avg_deficit is not None else "  Avg deficit: no data",
    ]
    if missed:
        lines.append("  Missed days:")
        for m in missed:
            deficit_str = f"{int(m['deficit'])} kcal" if m["deficit"] is not None else "no data"
            lines.append(f"    {m['date']}: {m['direction']} (deficit={deficit_str})")
    else:
        lines.append("  All 7 days on target.")
    lines.append("----------------------------------------")

    return summary, "\n".join(lines)


# ---------------------------------------------------------------------------
# Planned next week query
# ---------------------------------------------------------------------------

def _fetch_planned_next_week() -> list[dict]:
    today = date.today()
    next_week_end = today + timedelta(days=7)

    sql = """
        SELECT planned_date, class_type, duration_min, estimated_tss, notes
        FROM planned_workouts
        WHERE planned_date BETWEEN %(start)s AND %(end)s
        ORDER BY planned_date, class_type;
    """
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, {"start": today, "end": next_week_end})
            rows = cur.fetchall()
    finally:
        conn.close()

    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def run_weekly_plan(no_save: bool = False) -> str:
    today = date.today()

    # Fetch last 14 days
    data_14 = export_daily_json(today - timedelta(days=13), today)
    days_14 = data_14.get("days", [])

    # Fetch 90-day window summary
    data_90 = export_daily_json(today - timedelta(days=89), today)
    quarter_summary = data_90.get("window_summary")

    # Planned next week
    planned_next_week = _fetch_planned_next_week()

    # Compute deficit adherence
    adherence_summary, adherence_print = _compute_deficit_adherence(days_14)

    # Print adherence before Claude call for spot-checking
    print(adherence_print)

    # Format deficit adherence string for Claude
    missed_str = (
        ", ".join(f"{m['date']} ({m['direction']})" for m in adherence_summary["missed"])
        if adherence_summary["missed"]
        else "none"
    )
    adherence_str = (
        f"{adherence_summary['days_on_target']}/7 | "
        f"avg deficit: {adherence_summary['avg_deficit']} kcal | "
        f"missed: {missed_str}"
    )

    # Build user message
    days_14_json = json.dumps(days_14, indent=2, default=str)
    quarter_json = json.dumps(quarter_summary, indent=2, default=str) if quarter_summary else "null"
    planned_json = json.dumps(
        [dict(r, planned_date=str(r["planned_date"])) for r in planned_next_week],
        indent=2, default=str
    )

    user_message = (
        f"LAST_14_DAYS: {days_14_json}\n\n"
        f"QUARTER_SUMMARY: {quarter_json}\n\n"
        f"DEFICIT_ADHERENCE: {adherence_str}\n\n"
        f"PLANNED_NEXT_WEEK: {planned_json}"
    )

    # Claude call
    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )
    analysis: str = response.content[0].text

    # Assemble output
    sep = "=" * 72
    lines = [
        sep,
        f"WEEKLY PLAN REVIEW — {today.isoformat()}",
        sep,
        "",
        analysis,
        "",
        sep,
    ]
    output = "\n".join(lines)

    sys.stdout.buffer.write((output + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

    if not no_save:
        LOGS_DIR.mkdir(exist_ok=True)
        log_file = LOGS_DIR / f"weekly_plan_{today.isoformat()}.txt"
        log_file.write_text(output, encoding="utf-8")
        print(f"\n[SAVED] {log_file}")

    return output


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Weekly data review via Claude",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--no-save",
        action="store_true",
        help="Print to terminal only; do not write to analysis_logs/",
    )
    args = parser.parse_args()
    run_weekly_plan(no_save=args.no_save)


if __name__ == "__main__":
    main()
