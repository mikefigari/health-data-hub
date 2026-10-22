#!/usr/bin/env python
"""
analyze_training.py — AI-powered training analysis via Claude.

Usage:
    python analyze_training.py [--week-only] [--no-save] [--email]

Flags:
    --week-only   Skip the 90-day query (faster, 7-day context only)
    --no-save     Don't write output to analysis_logs/YYYY-MM-DD.txt
    --email       Trigger email stub (not yet wired to SMTP)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import anthropic

# Ensure the package is importable when run as a top-level script
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

from health_data_hub.etl.export_daily_json import export_daily_json

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LOGS_DIR = PROJECT_ROOT / "analysis_logs"

SYSTEM_PROMPT = """\
You are an elite cycling coach and sports nutritionist analysing an athlete's \
training and recovery data.

ATHLETE CONTEXT
- Goal: lose 27 kg while preserving cycling power output.
- Primary performance metric: w/kg — this is the north star. Every training \
decision should be evaluated through the lens of how it moves w/kg.
- Caloric strategy: sustained ~500 kcal/day deficit. Flag any day where \
calories logged are significantly over or under target.
- TSB floor: TSB must NOT drop below -20. Fatigue accumulation is \
disproportionately risky during a caloric deficit.
- CTL strategy: MAINTAIN current CTL. Do NOT attempt to build CTL during the \
weight-loss phase — added training stress on a deficit risks injury and \
hormonal suppression.
- Weight is the first weigh-in of the day from a Renpho smart scale via Apple Health, in kg (nutrition.weight_kg in each day record). \
Calculate w/kg using avg_watts or np_watts from that day's workout. \
Track the trend across the window and flag if power is eroding faster than \
weight is dropping.

ANALYSIS RULES
- Be specific and reference actual numbers (TSB, CTL, HRV, sleep scores, \
kcal logged).
- Flag any day where TSB < -20 or nutrition logging is incomplete.
- Highlight w/kg implications for every hard training block.
- If weight data is absent for a given day (weight_kg is null), note it but don't \
block the analysis.
- Keep weekly analysis under 400 words; quarterly summaries under 200 words.
- Give concrete, actionable recommendations — no generic platitudes."""


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

def _build_week_prompt(days: list[dict], window_summary: dict | None) -> str:
    days_json = json.dumps(days, indent=2, default=str)
    summary_json = json.dumps(window_summary, indent=2, default=str) if window_summary else "null"
    return f"""\
Analyse the past 7 days of training data.

DAILY DATA (7 days, most-recent first):
{days_json}

PMC WINDOW SUMMARY (7-day):
{summary_json}

Provide:
1. PMC status (CTL / ATL / TSB trend) — flag any day where TSB < -20
2. Training load vs recovery balance
3. Sleep + HRV quality summary
4. Nutrition compliance (is the caloric deficit on track?)
5. w/kg trend (compute from nutrition.weight_kg + workout avg_watts/np_watts; note any null weight days)
6. Top 2 actionable recommendations for the coming 7 days
"""


def _build_quarter_prompt(window_summary: dict | None) -> str:
    summary_json = json.dumps(window_summary, indent=2, default=str) if window_summary else "null"
    return f"""\
Provide a concise 90-day training trend summary.

PMC WINDOW SUMMARY (90-day):
{summary_json}

In under 200 words: assess the CTL trajectory, whether TSB has stayed above \
-20 across the window, and whether the athlete is on track to maintain power \
during the weight-loss phase. Flag any structural concerns.
"""


# ---------------------------------------------------------------------------
# Email stub
# ---------------------------------------------------------------------------

def _email_stub(subject: str, body: str) -> None:
    """Placeholder — wire to SMTP or SendGrid in a future iteration."""
    # TODO: implement email delivery — add SMTP config to settings.py or env
    print(f"[EMAIL STUB] Would send: subject='{subject}', body_length={len(body)} chars")


# ---------------------------------------------------------------------------
# Core analysis
# ---------------------------------------------------------------------------

def analyze(
    week_only: bool = False,
    no_save: bool = False,
    send_email: bool = False,
) -> str:
    today = date.today()

    # --- Fetch data ---
    week_data = export_daily_json(today - timedelta(days=6), today)
    week_days: list[dict] = week_data.get("days", [])
    week_summary: dict | None = week_data.get("window_summary")

    quarter_summary: dict | None = None
    if not week_only:
        quarter_data = export_daily_json(today - timedelta(days=89), today)
        quarter_summary = quarter_data.get("window_summary")

    # --- Claude API calls ---
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from environment

    week_response = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": _build_week_prompt(week_days, week_summary)}],
    )
    week_analysis: str = week_response.content[0].text

    quarter_analysis = ""
    if not week_only and quarter_summary is not None:
        quarter_response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=512,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": _build_quarter_prompt(quarter_summary)}],
        )
        quarter_analysis = quarter_response.content[0].text

    # --- Assemble output ---
    sep = "=" * 72
    lines = [
        sep,
        f"TRAINING ANALYSIS — {today.isoformat()}",
        sep,
        "",
        "## 7-DAY ANALYSIS",
        "",
        week_analysis,
    ]

    if quarter_analysis:
        lines += [
            "",
            sep,
            "## 90-DAY TREND SUMMARY",
            "",
            quarter_analysis,
        ]

    lines += [
        "",
        sep,
        "OPEN TODOs / DATA GAPS",
        "  [TODO] Email delivery not wired — pass --email to see the stub output.",
        sep,
    ]

    output = "\n".join(lines)

    # --- Print to terminal ---
    print(output)

    # --- Save to analysis_logs/ ---
    if not no_save:
        LOGS_DIR.mkdir(exist_ok=True)
        log_file = LOGS_DIR / f"{today.isoformat()}.txt"
        log_file.write_text(output, encoding="utf-8")
        print(f"\n[SAVED] {log_file}")

    # --- Email stub ---
    if send_email:
        _email_stub(f"Training Analysis {today.isoformat()}", output)

    return output


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="AI-powered training analysis via Claude",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--week-only",
        action="store_true",
        help="Skip the 90-day PMC query (faster, uses only the 7-day window)",
    )
    parser.add_argument(
        "--no-save",
        action="store_true",
        help="Print to terminal only; do not write to analysis_logs/",
    )
    parser.add_argument(
        "--email",
        action="store_true",
        help="Trigger the email stub (prints a placeholder until SMTP is wired)",
    )
    args = parser.parse_args()
    analyze(week_only=args.week_only, no_save=args.no_save, send_email=args.email)


if __name__ == "__main__":
    main()
