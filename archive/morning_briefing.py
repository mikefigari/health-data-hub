#!/usr/bin/env python
"""
morning_briefing.py — Daily data readout via Claude.

Tells the athlete what their body is showing this morning across sleep,
fatigue, and nutrition. No workout instructions — the athlete decides.

Usage:
    python morning_briefing.py [--no-save]

Flags:
    --no-save   Print to terminal only; do not write to analysis_logs/
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import anthropic

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from health_data_hub.etl.export_daily_json import export_daily_json
from health_data_hub.integrations.apple_health.nutrition_reader import get_nutrition
from health_data_hub.utils.units import convert_kj_to_kcal

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LOGS_DIR = PROJECT_ROOT / "analysis_logs"

TDEE_BASELINE = 2800          # kcal rest day. Update as weight drops.
WORKOUT_KCAL_PER_TSS = 4      # estimated kcal burn per TSS point

SYSTEM_PROMPT = """\
You are a data analyst for an endurance athlete focused on losing 27kg while
preserving cycling power (w/kg). You analyse sleep, fatigue, and nutrition data
and report what the numbers say. You do not schedule workouts or tell the athlete
what to train — they are in charge of that.

The athlete records a daily physical state. Use this as a primary signal alongside
Oura data — if physical state is poor and Oura readiness is low, that is a strong
combined fatigue signal. If they diverge, flag it.

Deficit target is 500-750 kcal/day. If Oura sleep score has been below 70 for
two or more of the last three nights, flag that a deeper deficit may be working
against recovery — elevated cortisol from poor sleep and caloric restriction
together can stall fat loss and accelerate muscle loss. Report this as a data
observation, not an instruction.

TDEE is approximately 2800 kcal on rest days. Workout days add estimated_tss * 4
kcal. Use this to compute today's estimated calorie target and report it as
context — the athlete decides whether to hit it.

You will receive TODAY_DATA: Oura readiness score, sleep score and duration,
TSB from PMC, physical_state recorded by the athlete, yesterday's calorie intake
and deficit, today's planned workout if any, and current weight + w/kg.

Nutrition data comes from Apple Health via Health Auto Export. If the nutrition
section contains "data_present: false", state exactly:
"Nutrition data not yet received from Apple Health for this date"
and do not attempt to analyse or estimate nutrition for that day.

For cycling workouts, energy is provided as both kJ (power meter) and an kcal
estimate derived from it. Prefer the kJ-derived kcal over TSS-based estimates
when available — it is labelled "Cycling energy (from power)". If no power data
is available for a cycling workout, the label will say "Cycling energy (estimated,
no power data)" and you should note the lower confidence.

Respond in this exact structure:

## Body state this morning
Two to three sentences. Synthesise Oura readiness, sleep score, TSB, and the
athlete's recorded physical state into an honest picture of where the body is.
If signals conflict, say so. Do not soften bad data.

## Fatigue flags
Bullet list of any amber or red signals in the data. Examples: TSB below -20,
sleep score below 65 two nights running, physical state poor despite low TSS,
ATL spiking faster than CTL can absorb. If no flags, say 'None today'.

## Nutrition yesterday
Actual deficit vs target. Whether protein target was hit (160g training days,
140g rest days). One sentence on what the trend looks like across the last 3 days.
No judgment — just the numbers.

## Today's calorie context
Estimated target: [TDEE + workout_kcal - deficit_target]. Show the arithmetic.
Note if today's planned TSS is significantly higher or lower than recent days.\
"""


# ---------------------------------------------------------------------------
# Helper: compute sleep score from export row
# ---------------------------------------------------------------------------

def _sleep_score_from_row(row: dict) -> int | None:
    """Extract Oura readiness score (used as sleep quality proxy when sleep score absent)."""
    readiness = row.get("readiness") or {}
    return readiness.get("score")


def _sleep_duration_hours(row: dict) -> float | None:
    sleep = row.get("sleep") or {}
    secs = sleep.get("total_sleep_sec")
    if secs is None:
        return None
    return round(secs / 3600, 2)


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def run_briefing(no_save: bool = False) -> str:
    today = date.today()
    # Fetch today + 3 prior days (4 days total)
    start = today - timedelta(days=3)
    data = export_daily_json(start, today)
    days = data.get("days", [])

    # days are ORDER BY day DESC — index 0 = today
    today_row = next((d for d in days if d.get("day") == today.isoformat()), None)
    if today_row is None and days:
        today_row = days[0]  # fallback to most recent

    # Last 3 nights sleep (excluding today)
    sleep_rows = [d for d in days if d.get("day") != today.isoformat()][:3]
    last_3_nights = []
    for r in sleep_rows:
        sleep = r.get("sleep") or {}
        readiness = r.get("readiness") or {}
        last_3_nights.append({
            "date":           r.get("day"),
            "score":          readiness.get("score"),
            "duration_hours": _sleep_duration_hours(r),
        })

    # --- Nutrition: read from Apple Health JSON store ---
    nutrition = get_nutrition(today.isoformat())
    if not nutrition["data_present"]:
        # Also check yesterday in case today's data hasn't arrived yet
        yesterday = today - timedelta(days=1)
        nutrition_yesterday = get_nutrition(yesterday.isoformat())
    else:
        nutrition_yesterday = None

    # Attach nutrition to today_row for the prompt (override DB value with fresh JSON-store data)
    if today_row is None:
        today_row = {}
    if nutrition["data_present"]:
        today_row["nutrition"] = nutrition
    elif nutrition_yesterday and nutrition_yesterday["data_present"]:
        today_row["nutrition_yesterday"] = nutrition_yesterday
        today_row.setdefault("nutrition", {})["data_present"] = False
    else:
        today_row.setdefault("nutrition", {})["data_present"] = False

    # --- Annotate cycling workout energy from kJ ---
    _CYCLING_TYPES = {"Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "EBikeRide"}
    for workout in today_row.get("workouts") or []:
        if workout.get("sport_type") in _CYCLING_TYPES:
            kj = workout.get("kj") or 0
            if kj > 0:
                kcal = convert_kj_to_kcal(kj)
                workout["cycling_energy_label"] = (
                    f"Cycling energy (from power): ~{kcal} kcal (converted from {kj} kJ)"
                )
            else:
                workout["cycling_energy_label"] = (
                    "Cycling energy (estimated, no power data): see Oura active kcal"
                )

    # Build user message
    today_json = json.dumps(today_row, indent=2, default=str) if today_row else "{}"
    last3_json = json.dumps(last_3_nights, indent=2, default=str)

    user_message = (
        f"TODAY_DATA: {today_json}\n"
        f"LAST_3_NIGHTS_SLEEP: {last3_json}"
    )

    # Claude call
    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=512,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )
    analysis: str = response.content[0].text

    # Assemble output
    sep = "=" * 72
    lines = [
        sep,
        f"MORNING BRIEFING — {today.isoformat()}",
        sep,
        "",
        analysis,
        "",
        sep,
    ]
    output = "\n".join(lines)

    print(output)

    if not no_save:
        LOGS_DIR.mkdir(exist_ok=True)
        log_file = LOGS_DIR / f"morning_{today.isoformat()}.txt"
        log_file.write_text(output, encoding="utf-8")
        print(f"\n[SAVED] {log_file}")

    return output


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Daily morning data briefing via Claude",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--no-save",
        action="store_true",
        help="Print to terminal only; do not write to analysis_logs/",
    )
    args = parser.parse_args()
    run_briefing(no_save=args.no_save)


if __name__ == "__main__":
    main()
