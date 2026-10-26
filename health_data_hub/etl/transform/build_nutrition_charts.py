"""Build the weight and nutrition datasets used by the Datawrapper charts.

Four datasets:
- weight:   every weigh-in plus a trailing 7-day average
- daily:    last 14 days of calories and protein against their goals
- weekly:   per Monday-start week, days the protein and calorie goals were met
"""

from __future__ import annotations

import csv
import io
from datetime import date, timedelta

DAILY_DAYS = 14
WEEKLY_WEEKS = 8
AVG_WINDOW_DAYS = 7

WEIGHT_HEADER = ["date", "Weight (kg)", "7-day average (kg)"]
DAILY_HEADER = ["date", "Calories", "Calorie goal", "Protein (g)", "Protein goal (g)"]
WEEKLY_HEADER = ["week_of", "Protein goal met", "Calories at or under goal", "Days logged"]

_WEIGHT_SQL = (
    "SELECT day, weight_kg FROM body_weight_daily "
    "WHERE weight_kg IS NOT NULL ORDER BY day"
)
_NUTRITION_SQL = (
    "SELECT day, calories, protein_g, goal_calories, goal_protein_g, logged_complete "
    "FROM nutrition_daily WHERE day >= %s ORDER BY day"
)


def fetch_today(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date")
        return cur.fetchone()[0]


def fetch_weight(conn):
    with conn.cursor() as cur:
        cur.execute(_WEIGHT_SQL)
        return [(d, w) for d, w in cur.fetchall()]


def fetch_nutrition(conn, today):
    since = week_start(today) - timedelta(weeks=WEEKLY_WEEKS - 1)
    since = min(since, today - timedelta(days=DAILY_DAYS - 1))
    with conn.cursor() as cur:
        cur.execute(_NUTRITION_SQL, (since,))
        return [
            {"day": d, "calories": c, "protein_g": p, "goal_calories": gc,
             "goal_protein_g": gp, "logged_complete": lc}
            for d, c, p, gc, gp, lc in cur.fetchall()
        ]


def week_start(d):
    return d - timedelta(days=d.weekday())


def _num(v):
    if v is None:
        return None
    f = float(v)
    return int(f) if f == int(f) else round(f, 1)


def build_weight_rows(weight_rows):
    weights = {d: float(w) for d, w in weight_rows}
    days = sorted(weights)
    rows = []
    for d in days:
        lo = d - timedelta(days=AVG_WINDOW_DAYS - 1)
        window = [weights[x] for x in days if lo <= x <= d]
        rows.append({
            "date": d,
            "weight_kg": round(weights[d], 2),
            "avg_kg": round(sum(window) / len(window), 2),
        })
    return rows


def _logged(r):
    """A day counts only when it was confirmed complete and has a goal to judge against."""
    return bool(r["logged_complete"]) and r["calories"] is not None


def build_daily_rows(nutrition, today):
    by_day = {r["day"]: r for r in nutrition}
    rows = []
    for i in range(DAILY_DAYS - 1, -1, -1):
        d = today - timedelta(days=i)
        r = by_day.get(d)
        if r is None or not _logged(r):
            rows.append({"date": d, "calories": None, "goal_calories": None,
                         "protein_g": None, "goal_protein_g": None})
            continue
        rows.append({
            "date": d,
            "calories": _num(r["calories"]),
            "goal_calories": _num(r["goal_calories"]),
            "protein_g": _num(r["protein_g"]),
            "goal_protein_g": _num(r["goal_protein_g"]),
        })
    return rows


def build_weekly_rows(nutrition, today):
    this_week = week_start(today)
    weeks = [this_week - timedelta(weeks=i) for i in range(WEEKLY_WEEKS - 1, -1, -1)]
    stats = {w: {"protein": 0, "calories": 0, "logged": 0} for w in weeks}
    for r in nutrition:
        w = week_start(r["day"])
        if w not in stats or not _logged(r):
            continue
        s = stats[w]
        s["logged"] += 1
        if r["goal_protein_g"] is not None and r["protein_g"] is not None \
                and float(r["protein_g"]) >= float(r["goal_protein_g"]):
            s["protein"] += 1
        if r["goal_calories"] is not None and float(r["calories"]) <= float(r["goal_calories"]):
            s["calories"] += 1
    return [{"week_of": w, "protein_met": stats[w]["protein"],
             "calories_met": stats[w]["calories"], "logged": stats[w]["logged"]}
            for w in weeks]


def _csv(header, rows):
    buf = io.StringIO()
    wr = csv.writer(buf, lineterminator="\n")
    wr.writerow(header)
    for r in rows:
        wr.writerow(["" if v is None else (v.isoformat() if isinstance(v, date) else v)
                     for v in r])
    return buf.getvalue()


def weight_csv(rows):
    return _csv(WEIGHT_HEADER, [(r["date"], r["weight_kg"], r["avg_kg"]) for r in rows])


def daily_csv(rows):
    return _csv(DAILY_HEADER, [(r["date"], r["calories"], r["goal_calories"],
                                r["protein_g"], r["goal_protein_g"]) for r in rows])


def weekly_csv(rows):
    return _csv(WEEKLY_HEADER, [(r["week_of"], r["protein_met"], r["calories_met"], r["logged"])
                                for r in rows])
