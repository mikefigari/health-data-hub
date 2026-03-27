from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Optional

from PIL import Image, ImageColor, ImageDraw, ImageFont
from psycopg2.extras import RealDictCursor

from health_data_hub.config.settings import PROJECT_ROOT
from health_data_hub.utils.db_connect import get_connection


DEFAULT_GRAPH_DIR = PROJECT_ROOT / "generated" / "power_zone_graphs"
DEFAULT_ZONE_CONFIG_PATH = PROJECT_ROOT / "health_data_hub" / "config" / "power_zones.json"


@dataclass(frozen=True)
class PowerZone:
    index: int
    name: str
    label: str
    lower_pct: float
    upper_pct: Optional[float]
    color: str

    def lower_watts(self, ftp_watts: float) -> int:
        return int(round(self.lower_pct * ftp_watts))

    def upper_watts(self, ftp_watts: float) -> Optional[int]:
        if self.upper_pct is None:
            return None
        return int(round(self.upper_pct * ftp_watts))


DEFAULT_POWER_ZONES = [
    PowerZone(1, "Z1", "Active Recovery", 0.00, 0.55, "#D9D9D9"),
    PowerZone(2, "Z2", "Endurance", 0.55, 0.75, "#4A90E2"),
    PowerZone(3, "Z3", "Tempo", 0.75, 0.90, "#3CB371"),
    PowerZone(4, "Z4", "Threshold", 0.90, 1.05, "#F2C94C"),
    PowerZone(5, "Z5", "VO2 Max", 1.05, 1.20, "#F2994A"),
    PowerZone(6, "Z6", "Anaerobic", 1.20, 1.50, "#EB5757"),
    PowerZone(7, "Z7", "Neuromuscular", 1.50, None, "#8B1E3F"),
]


def _load_font(size: int, bold: bool = False):
    font_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    ]
    for path in font_paths:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def _format_duration(total_seconds: Optional[int]) -> str:
    if total_seconds is None:
        return "n/a"
    total_seconds = int(total_seconds)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:d}:{seconds:02d}"


def _format_watts(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{int(round(value))} W"


def _lighten(color: str, amount: float = 0.70) -> str:
    r, g, b = ImageColor.getrgb(color)
    return "#%02x%02x%02x" % (
        int(r + (255 - r) * amount),
        int(g + (255 - g) * amount),
        int(b + (255 - b) * amount),
    )


def _load_zone_config(config_path: Optional[Path]) -> list[PowerZone]:
    if not config_path or not config_path.exists():
        return DEFAULT_POWER_ZONES

    with config_path.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)

    zones = []
    for idx, item in enumerate(payload.get("zones", []), start=1):
        zones.append(
            PowerZone(
                index=item.get("index", idx),
                name=item["name"],
                label=item.get("label", item["name"]),
                lower_pct=float(item["lower_pct"]),
                upper_pct=None if item.get("upper_pct") is None else float(item["upper_pct"]),
                color=item.get("color", DEFAULT_POWER_ZONES[min(idx - 1, len(DEFAULT_POWER_ZONES) - 1)].color),
            )
        )
    return zones or DEFAULT_POWER_ZONES


def _fetch_workout_graph_data(workout_id: int) -> Optional[dict]:
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    wr.id,
                    wr.external_id,
                    wr.title,
                    wr.sport_type,
                    wr.start_time,
                    wr.moving_s,
                    wr.elapsed_s,
                    wr.avg_watts,
                    wr.max_watts,
                    wr.weighted_average_watts,
                    wr.kj,
                    ws.np_watts,
                    ws.intensity_factor,
                    ws.tss_power
                FROM workouts_raw wr
                LEFT JOIN workout_summary ws
                  ON ws.workout_id = wr.id
                WHERE wr.id = %s
                """,
                (workout_id,),
            )
            workout = cur.fetchone()
            if not workout:
                return None

            start_time = workout.get("start_time")
            ftp_watts = None
            if start_time:
                cur.execute(
                    """
                    SELECT ftp_watts
                    FROM ftp_history
                    WHERE effective_from <= %s::date
                    ORDER BY effective_from DESC
                    LIMIT 1
                    """,
                    (start_time.date(),),
                )
                ftp_row = cur.fetchone()
                if ftp_row:
                    ftp_watts = ftp_row["ftp_watts"]

            if ftp_watts is None:
                cur.execute(
                    """
                    SELECT ftp_watts
                    FROM ftp_history
                    ORDER BY effective_from DESC
                    LIMIT 1
                    """
                )
                ftp_row = cur.fetchone()
                if ftp_row:
                    ftp_watts = ftp_row["ftp_watts"]

            cur.execute(
                """
                SELECT
                    COALESCE(second_index, ts_seconds) AS second_index,
                    ts_seconds,
                    watts
                FROM workout_samples
                WHERE workout_id = %s
                ORDER BY COALESCE(second_index, ts_seconds), ts_seconds
                """,
                (workout_id,),
            )
            samples = cur.fetchall()

        workout["ftp_watts"] = ftp_watts
        workout["samples"] = samples
        return workout
    finally:
        conn.close()


def _zone_for_watts(watts: Optional[float], zones: Iterable[PowerZone], ftp_watts: float) -> Optional[PowerZone]:
    if watts is None:
        return None
    zones = list(zones)
    for zone in zones:
        upper = zone.upper_watts(ftp_watts)
        if upper is None and watts >= zone.lower_watts(ftp_watts):
            return zone
        if upper is not None and zone.lower_watts(ftp_watts) <= watts < upper:
            return zone
    return zones[-1] if zones else None


def _bucket_samples(
    samples: list[dict],
    zones: list[PowerZone],
    ftp_watts: float,
    chart_width: int,
) -> list[dict]:
    if not samples:
        return []

    bucket_size = max(1, math.ceil(len(samples) / chart_width))
    buckets = []
    zone_lookup = {zone.index: zone for zone in zones}

    for start in range(0, len(samples), bucket_size):
        chunk = samples[start:start + bucket_size]
        watts_values = [float(s["watts"]) for s in chunk if s.get("watts") is not None]
        zone_indices = [
            _zone_for_watts(s.get("watts"), zones, ftp_watts).index
            for s in chunk
            if s.get("watts") is not None
        ]
        dominant_zone = None
        if zone_indices:
            dominant_zone = zone_lookup[max(set(zone_indices), key=zone_indices.count)]

        buckets.append(
            {
                "avg_watts": float(sum(watts_values) / len(watts_values)) if watts_values else None,
                "zone": dominant_zone,
                "second_start": chunk[0].get("ts_seconds") or chunk[0].get("second_index") or start,
                "second_end": chunk[-1].get("ts_seconds") or chunk[-1].get("second_index") or (start + len(chunk) - 1),
            }
        )

    return buckets


def _compute_zone_distribution(samples: list[dict], zones: list[PowerZone], ftp_watts: float) -> list[dict]:
    counts = {zone.index: 0 for zone in zones}
    total_power_seconds = 0

    for sample in samples:
        zone = _zone_for_watts(sample.get("watts"), zones, ftp_watts)
        if zone is None:
            continue
        counts[zone.index] += 1
        total_power_seconds += 1

    distribution = []
    for zone in zones:
        seconds = counts[zone.index]
        pct = (seconds / total_power_seconds * 100.0) if total_power_seconds else 0.0
        distribution.append({"zone": zone, "seconds": seconds, "pct": pct})
    return distribution


def _draw_text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, font, fill: str):
    draw.text(xy, text, font=font, fill=fill)


def generate_power_zone_graph(
    workout_id: int,
    output_dir: Optional[Path] = None,
    config_path: Optional[Path] = None,
) -> Optional[dict]:
    workout = _fetch_workout_graph_data(workout_id)
    if not workout:
        return None

    ftp_watts = workout.get("ftp_watts")
    samples = workout.get("samples") or []
    if not ftp_watts or not samples:
        return None

    zones = _load_zone_config(config_path or DEFAULT_ZONE_CONFIG_PATH)
    distribution = _compute_zone_distribution(samples, zones, float(ftp_watts))
    power_seconds = sum(item["seconds"] for item in distribution)
    if power_seconds == 0:
        return None

    width = 1800
    height = 1040
    panel_gap = 40
    summary_width = 360
    margin_left = 90
    margin_top = 120
    chart_height = 660
    chart_width = width - margin_left - summary_width - panel_gap - 60
    chart_left = margin_left
    chart_top = margin_top + 40
    chart_bottom = chart_top + chart_height
    chart_right = chart_left + chart_width
    summary_left = chart_right + panel_gap

    power_values = [float(s["watts"]) for s in samples if s.get("watts") is not None]
    if not power_values:
        return None

    max_power_sample = max(power_values)
    max_zone_ceiling = max(
        z.upper_watts(float(ftp_watts)) or float(ftp_watts) * 1.7
        for z in zones
    )
    y_max = max(float(ftp_watts) * 1.6, max_power_sample * 1.08, max_zone_ceiling)
    y_max = int(math.ceil(y_max / 25.0) * 25)

    image = Image.new("RGB", (width, height), "#FAF8F3")
    draw = ImageDraw.Draw(image, "RGBA")

    title_font = _load_font(34, bold=True)
    subtitle_font = _load_font(18)
    label_font = _load_font(16)
    small_font = _load_font(14)
    summary_font = _load_font(18)
    summary_bold_font = _load_font(20, bold=True)

    title = workout.get("title") or f"Workout {workout_id}"
    ride_date = workout.get("start_time")
    ride_date_str = ride_date.strftime("%Y-%m-%d %H:%M") if isinstance(ride_date, datetime) else "Unknown date"
    sport_type = workout.get("sport_type") or "Ride"

    _draw_text(draw, (margin_left, 34), title, title_font, "#1A1A1A")
    _draw_text(
        draw,
        (margin_left, 74),
        f"{sport_type}  |  {ride_date_str}  |  FTP {int(round(float(ftp_watts)))} W",
        subtitle_font,
        "#4F4F4F",
    )

    metric_y = height - 170
    metrics = [
        ("Avg", _format_watts(workout.get("avg_watts"))),
        ("NP", _format_watts(workout.get("np_watts"))),
        ("Max", _format_watts(workout.get("max_watts"))),
        ("TSS", f"{int(round(workout['tss_power']))}" if workout.get("tss_power") is not None else "n/a"),
        ("Duration", _format_duration(workout.get("moving_s") or workout.get("elapsed_s") or power_seconds)),
    ]
    metric_x = margin_left
    for label, value in metrics:
        draw.rounded_rectangle((metric_x, metric_y, metric_x + 150, metric_y + 78), radius=18, fill="#FFFFFF", outline="#E8E1D7")
        _draw_text(draw, (metric_x + 18, metric_y + 14), label, label_font, "#7A6F63")
        _draw_text(draw, (metric_x + 18, metric_y + 40), value, summary_bold_font, "#1A1A1A")
        metric_x += 166

    for zone in zones:
        lower = zone.lower_watts(float(ftp_watts))
        upper = zone.upper_watts(float(ftp_watts)) or y_max
        lower = max(0, lower)
        upper = min(y_max, upper)
        if upper <= lower:
            continue
        y1 = chart_bottom - int(lower / y_max * chart_height)
        y0 = chart_bottom - int(upper / y_max * chart_height)
        draw.rectangle((chart_left, y0, chart_right, y1), fill=_lighten(zone.color, 0.84))
        _draw_text(draw, (chart_left + 10, y0 + 6), zone.name, small_font, "#5F5A54")

    for watt_mark in range(0, y_max + 1, 50):
        y = chart_bottom - int(watt_mark / y_max * chart_height)
        draw.line((chart_left, y, chart_right, y), fill="#DED7CD", width=1)
        _draw_text(draw, (chart_left - 52, y - 8), f"{watt_mark}", small_font, "#6E675D")

    time_ticks = 6
    total_seconds = max(power_seconds, int(workout.get("moving_s") or power_seconds))
    for tick in range(time_ticks + 1):
        x = chart_left + int(chart_width * tick / time_ticks)
        draw.line((x, chart_top, x, chart_bottom), fill="#ECE5DA", width=1)
        seconds = int(total_seconds * tick / time_ticks)
        _draw_text(draw, (x - 15, chart_bottom + 12), _format_duration(seconds), small_font, "#6E675D")

    draw.rectangle((chart_left, chart_top, chart_right, chart_bottom), outline="#CFC5B6", width=2)

    buckets = _bucket_samples(samples, zones, float(ftp_watts), chart_width)
    area_points = [(chart_left, chart_bottom)]
    line_points = []

    bucket_count = len(buckets)
    if bucket_count <= 1:
        x_positions = [chart_left] * bucket_count
    else:
        x_positions = [
            chart_left + int((chart_width - 1) * idx / (bucket_count - 1))
            for idx in range(bucket_count)
        ]

    for idx, bucket in enumerate(buckets):
        x = x_positions[idx]
        next_x = x_positions[idx + 1] if idx + 1 < bucket_count else x

        zone = bucket.get("zone")
        if zone is not None:
            draw.rectangle((x, chart_top, next_x, chart_bottom), fill=ImageColor.getrgb(zone.color) + (42,))

        avg_watts = bucket.get("avg_watts")
        if avg_watts is None:
            continue
        y = chart_bottom - int(avg_watts / y_max * chart_height)
        area_points.append((x, y))
        line_points.append((x, y))
    if line_points:
        area_points.extend([(line_points[-1][0], chart_bottom), (chart_left, chart_bottom)])
        draw.polygon(area_points, fill=(31, 47, 61, 88))
        draw.line(line_points, fill="#102331", width=3)

    ftp_y = chart_bottom - int(float(ftp_watts) / y_max * chart_height)
    draw.line((chart_left, ftp_y, chart_right, ftp_y), fill="#111111", width=2)
    _draw_text(draw, (chart_right - 72, ftp_y - 22), "FTP", summary_font, "#111111")

    _draw_text(draw, (summary_left, chart_top - 40), "Time In Zone", summary_bold_font, "#1A1A1A")
    _draw_text(draw, (summary_left, chart_top - 12), "Peloton-style thresholds from active FTP", small_font, "#6A6258")

    bar_width = 220
    row_y = chart_top + 24
    for item in distribution:
        zone = item["zone"]
        seconds = item["seconds"]
        pct = item["pct"]
        upper = zone.upper_watts(float(ftp_watts))
        upper_label = f"{upper} W" if upper is not None else "+"

        draw.rounded_rectangle((summary_left, row_y, summary_left + summary_width - 10, row_y + 78), radius=16, fill="#FFFFFF", outline="#E8E1D7")
        draw.rounded_rectangle((summary_left + 14, row_y + 16, summary_left + 74, row_y + 62), radius=12, fill=zone.color)
        _draw_text(draw, (summary_left + 28, row_y + 29), zone.name, summary_font, "#FFFFFF")
        _draw_text(
            draw,
            (summary_left + 92, row_y + 14),
            f"{zone.label}  |  {zone.lower_watts(float(ftp_watts))} W to {upper_label}",
            small_font,
            "#564F48",
        )
        draw.rounded_rectangle((summary_left + 92, row_y + 40, summary_left + 92 + bar_width, row_y + 54), radius=7, fill="#EEE7DD")
        fill_width = int(bar_width * (pct / 100.0))
        if fill_width > 0:
            draw.rounded_rectangle((summary_left + 92, row_y + 40, summary_left + 92 + fill_width, row_y + 54), radius=7, fill=zone.color)
        _draw_text(draw, (summary_left + 92, row_y + 58), _format_duration(seconds), summary_font, "#1A1A1A")
        _draw_text(draw, (summary_left + 250, row_y + 58), f"{pct:4.1f}%", summary_font, "#564F48")
        row_y += 92

    footer = "Background bands show power zones. Vertical color strips mark the dominant zone for each visible time slice."
    _draw_text(draw, (margin_left, height - 42), footer, small_font, "#6A6258")

    output_dir = output_dir or DEFAULT_GRAPH_DIR
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = f"workout_{workout_id}_power_zone.png"
    output_path = output_dir / filename
    image.save(output_path, format="PNG")

    return {
        "workout_id": workout_id,
        "workout_title": title,
        "ftp_watts": float(ftp_watts),
        "output_path": output_path,
        "zone_distribution": distribution,
    }


def _fetch_weekly_zone_data(week_start: date, week_end: date) -> Optional[dict]:
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    wr.id            AS workout_id,
                    wr.title,
                    wr.start_time,
                    wr.sport_type,
                    wr.moving_s,
                    wr.kj,
                    ws.tss_power,
                    ws.np_watts
                FROM workouts_raw wr
                LEFT JOIN workout_summary ws ON ws.workout_id = wr.id
                WHERE wr.start_time::date BETWEEN %s AND %s
                  AND LOWER(REPLACE(wr.sport_type, ' ', '')) LIKE '%%ride%%'
                ORDER BY wr.start_time
                """,
                (week_start, week_end),
            )
            workouts = cur.fetchall()
            if not workouts:
                return None

            cur.execute(
                """
                SELECT ftp_watts
                FROM ftp_history
                WHERE effective_from <= %s
                ORDER BY effective_from DESC
                LIMIT 1
                """,
                (week_start,),
            )
            ftp_row = cur.fetchone()
            if not ftp_row:
                cur.execute(
                    "SELECT ftp_watts FROM ftp_history ORDER BY effective_from DESC LIMIT 1"
                )
                ftp_row = cur.fetchone()
            ftp_watts = ftp_row["ftp_watts"] if ftp_row else None
            if not ftp_watts:
                return None

            workout_ids = [w["workout_id"] for w in workouts]
            cur.execute(
                """
                SELECT workout_id, watts
                FROM workout_samples
                WHERE workout_id = ANY(%s)
                  AND watts IS NOT NULL
                ORDER BY workout_id, COALESCE(second_index, ts_seconds)
                """,
                (workout_ids,),
            )
            all_samples = cur.fetchall()

        return {
            "workouts": workouts,
            "ftp_watts": ftp_watts,
            "all_samples": all_samples,
            "week_start": week_start,
            "week_end": week_end,
        }
    finally:
        conn.close()


def generate_weekly_zone_summary_graph(
    week_start: date,
    output_dir: Optional[Path] = None,
    config_path: Optional[Path] = None,
) -> Optional[dict]:
    """Generate a weekly combined power-zone bar chart for all cycling workouts Mon–Sun."""
    if isinstance(week_start, datetime):
        week_start = week_start.date()
    # Snap to Monday
    week_start = week_start - timedelta(days=week_start.weekday())
    week_end = week_start + timedelta(days=6)

    data = _fetch_weekly_zone_data(week_start, week_end)
    if not data:
        return None

    workouts = data["workouts"]
    ftp_watts = float(data["ftp_watts"])
    all_samples = data["all_samples"]
    if not all_samples:
        return None

    zones = _load_zone_config(config_path or DEFAULT_ZONE_CONFIG_PATH)
    distribution = _compute_zone_distribution(all_samples, zones, ftp_watts)
    total_seconds = sum(item["seconds"] for item in distribution)
    if total_seconds == 0:
        return None

    total_tss = sum(
        float(w["tss_power"]) for w in workouts if w.get("tss_power") is not None
    )
    total_kj = sum(float(w["kj"]) for w in workouts if w.get("kj") is not None)

    # ── Canvas ────────────────────────────────────────────────────────────────
    width = 1800
    height = 1060
    margin_left = 72
    margin_right = 72

    image = Image.new("RGB", (width, height), "#FAF8F3")
    draw = ImageDraw.Draw(image, "RGBA")

    title_font       = _load_font(34, bold=True)
    subtitle_font    = _load_font(18)
    label_font       = _load_font(16)
    small_font       = _load_font(14)
    summary_font     = _load_font(18)
    summary_bold     = _load_font(20, bold=True)
    section_bold     = _load_font(22, bold=True)

    # ── Header ────────────────────────────────────────────────────────────────
    week_start_label = week_start.strftime("%a %b %-d")
    week_end_label   = week_end.strftime("%a %b %-d, %Y")
    _draw_text(draw, (margin_left, 32), "Weekly Zone Summary", title_font, "#1A1A1A")
    _draw_text(
        draw,
        (margin_left, 78),
        f"{week_start_label} – {week_end_label}  ·  FTP {int(round(ftp_watts))} W",
        subtitle_font,
        "#4F4F4F",
    )

    # ── Metrics row ───────────────────────────────────────────────────────────
    metrics = [
        ("Total Time",  _format_duration(total_seconds)),
        ("Rides",       str(len(workouts))),
        ("Total TSS",   f"{int(round(total_tss))}" if total_tss else "n/a"),
        ("Total kJ",    f"{int(round(total_kj))}" if total_kj else "n/a"),
    ]
    card_w, card_h, card_gap = 200, 78, 20
    card_y = 118
    card_x = margin_left
    for m_label, m_value in metrics:
        draw.rounded_rectangle(
            (card_x, card_y, card_x + card_w, card_y + card_h),
            radius=18, fill="#FFFFFF", outline="#E8E1D7",
        )
        _draw_text(draw, (card_x + 18, card_y + 12), m_label, label_font, "#7A6F63")
        _draw_text(draw, (card_x + 18, card_y + 38), m_value, summary_bold, "#1A1A1A")
        card_x += card_w + card_gap

    # ── Divider ───────────────────────────────────────────────────────────────
    divider_y = card_y + card_h + 18
    draw.line((margin_left, divider_y, width - margin_right, divider_y), fill="#DED7CD", width=1)

    # ── "Time In Zone" section label ──────────────────────────────────────────
    section_y = divider_y + 18
    _draw_text(draw, (margin_left, section_y), "Time In Zone", section_bold, "#1A1A1A")
    _draw_text(
        draw,
        (margin_left, section_y + 28),
        "Combined across all rides this week  ·  Peloton-style thresholds from active FTP",
        small_font,
        "#6A6258",
    )

    # ── Zone bars ─────────────────────────────────────────────────────────────
    bar_area_left  = margin_left + 220   # left edge of progress bar track
    bar_area_right = width - margin_right - 180  # right edge of progress bar track
    bar_track_w    = bar_area_right - bar_area_left
    time_x         = bar_area_right + 20
    pct_x          = time_x + 130

    row_y = section_y + 62
    row_h = 82

    for item in distribution:
        zone    = item["zone"]
        seconds = item["seconds"]
        pct     = item["pct"]
        upper   = zone.upper_watts(ftp_watts)
        upper_label = f"{upper} W" if upper is not None else "+"
        lower_label = f"{zone.lower_watts(ftp_watts)} W"

        # Zone pill
        draw.rounded_rectangle(
            (margin_left, row_y + 14, margin_left + 80, row_y + 60),
            radius=12, fill=zone.color,
        )
        _draw_text(draw, (margin_left + 14, row_y + 27), zone.name, summary_font, "#FFFFFF")

        # Label + watt range
        _draw_text(
            draw,
            (margin_left + 96, row_y + 14),
            zone.label,
            summary_font,
            "#1A1A1A",
        )
        _draw_text(
            draw,
            (margin_left + 96, row_y + 40),
            f"{lower_label} – {upper_label}",
            small_font,
            "#7A6F63",
        )

        # Progress bar track
        track_top    = row_y + 30
        track_bottom = row_y + 48
        draw.rounded_rectangle(
            (bar_area_left, track_top, bar_area_right, track_bottom),
            radius=8, fill="#EEE7DD",
        )
        fill_w = int(bar_track_w * (pct / 100.0))
        if fill_w > 0:
            draw.rounded_rectangle(
                (bar_area_left, track_top, bar_area_left + fill_w, track_bottom),
                radius=8, fill=zone.color,
            )

        # Time + pct
        _draw_text(draw, (time_x, row_y + 27), _format_duration(seconds), summary_font, "#1A1A1A")
        _draw_text(draw, (pct_x, row_y + 27), f"{pct:4.1f}%", summary_font, "#564F48")

        row_y += row_h

    # ── Combined Z1–3 / Z4–7 summary cards ───────────────────────────────────
    aerobic_secs = sum(item["seconds"] for item in distribution if item["zone"].index <= 3)
    intense_secs = sum(item["seconds"] for item in distribution if item["zone"].index >= 4)
    aerobic_pct  = aerobic_secs / total_seconds * 100 if total_seconds else 0.0
    intense_pct  = intense_secs / total_seconds * 100 if total_seconds else 0.0

    summary_card_w = 380
    summary_card_h = 64
    summary_gap    = 20
    summary_y      = row_y + 10

    for card_label, card_sub, card_time, card_pct, card_color in [
        ("Aerobic  Z1–Z3",  "Active Recovery · Endurance · Tempo",    aerobic_secs, aerobic_pct,  "#4A90E2"),
        ("High Intensity  Z4–Z7", "Threshold · VO2 Max · Anaerobic · Neuro", intense_secs, intense_pct, "#EB5757"),
    ]:
        draw.rounded_rectangle(
            (margin_left, summary_y, margin_left + summary_card_w, summary_y + summary_card_h),
            radius=14, fill="#FFFFFF", outline="#E8E1D7",
        )
        draw.rounded_rectangle(
            (margin_left + 12, summary_y + 12, margin_left + 18, summary_y + summary_card_h - 12),
            radius=3, fill=card_color,
        )
        _draw_text(draw, (margin_left + 28, summary_y + 8),  card_label, label_font, "#1A1A1A")
        _draw_text(draw, (margin_left + 28, summary_y + 30), card_sub,   small_font, "#7A6F63")
        _draw_text(
            draw,
            (margin_left + summary_card_w - 160, summary_y + 14),
            _format_duration(card_time),
            summary_font, "#1A1A1A",
        )
        _draw_text(
            draw,
            (margin_left + summary_card_w - 62, summary_y + 14),
            f"{card_pct:.1f}%",
            summary_bold, card_color,
        )
        margin_left += summary_card_w + summary_gap

    margin_left = 72  # restore

    # ── Workout list ──────────────────────────────────────────────────────────
    list_y = summary_y + summary_card_h + 12
    draw.line((margin_left, list_y, width - margin_right, list_y), fill="#DED7CD", width=1)
    list_y += 12

    parts = []
    for w in workouts:
        dt = w.get("start_time")
        date_str = dt.strftime("%-d %b") if isinstance(dt, datetime) else "?"
        title = (w.get("title") or "Ride")[:35]
        dur = _format_duration(w.get("moving_s"))
        tss = f"TSS {int(round(float(w['tss_power'])))}" if w.get("tss_power") is not None else ""
        parts.append(f"{date_str} · {title} · {dur}" + (f" · {tss}" if tss else ""))

    rides_line = "    |    ".join(parts)
    _draw_text(draw, (margin_left, list_y), rides_line, small_font, "#6A6258")

    # ── Footer ────────────────────────────────────────────────────────────────
    _draw_text(
        draw,
        (margin_left, height - 30),
        "Zone thresholds calculated from active FTP using Peloton power-zone percentages.",
        small_font,
        "#9E9086",
    )

    output_dir = output_dir or DEFAULT_GRAPH_DIR
    output_dir.mkdir(parents=True, exist_ok=True)
    week_tag  = week_start.strftime("%Y_W%V")
    filename  = f"weekly_zone_summary_{week_tag}.png"
    out_path  = output_dir / filename
    image.save(out_path, format="PNG")

    return {
        "week_start":         week_start,
        "week_end":           week_end,
        "ftp_watts":          ftp_watts,
        "output_path":        out_path,
        "zone_distribution":  distribution,
        "workout_count":      len(workouts),
        "total_seconds":      total_seconds,
    }


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        print("Usage: python -m health_data_hub.etl.transform.power_zone_graph <workout_id>")
        raise SystemExit(1)

    result = generate_power_zone_graph(int(sys.argv[1]))
    if result is None:
        print("No power-zone graph generated.")
        raise SystemExit(2)

    print(result["output_path"])
