"""
Email alerting utility.

Sends a plain-text alert email via SMTP (STARTTLS).
Configure in your env file:

    ALERT_EMAIL_TO         = you@example.com
    ALERT_SMTP_HOST        = smtp.gmail.com
    ALERT_SMTP_PORT        = 587
    ALERT_SMTP_USER        = you@gmail.com
    ALERT_SMTP_PASS        = <Gmail app password>
    ALERT_COOLDOWN_SECONDS = 7200   # optional, default 2 hours

If any of these are unset the alert is skipped and a warning is logged —
the caller is never broken by a missing email config.

Repeat alerts for the same subject are suppressed within the cooldown window
(default 2 hours). Cooldown state is persisted to disk so service restarts
don't reset the rate limit.
"""

from __future__ import annotations

import json
import logging
import os
import smtplib
import socket
import time
from email.message import EmailMessage
from pathlib import Path

logger = logging.getLogger(__name__)

_COOLDOWN_FILE = Path.home() / ".config" / "health-data-hub" / "alert_cooldowns.json"
_DEFAULT_COOLDOWN = 7200  # 2 hours


def _load_cooldowns() -> dict:
    try:
        if _COOLDOWN_FILE.exists():
            return json.loads(_COOLDOWN_FILE.read_text())
    except Exception:
        pass
    return {}


def _save_cooldowns(data: dict) -> None:
    try:
        _COOLDOWN_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _COOLDOWN_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data))
        tmp.replace(_COOLDOWN_FILE)
    except Exception as e:
        logger.warning("[alert] Could not persist cooldown state: %s", e)


def send_alert(subject: str, body: str) -> None:
    """Send a plain-text alert email.  Never raises — logs a warning on failure.

    Repeat alerts with the same subject are suppressed within the cooldown
    window (ALERT_COOLDOWN_SECONDS, default 2 hours) to prevent email floods.
    """
    cooldown = int(os.getenv("ALERT_COOLDOWN_SECONDS", str(_DEFAULT_COOLDOWN)))
    now = time.time()
    cooldowns = _load_cooldowns()
    last_sent = cooldowns.get(subject, 0)
    if now - last_sent < cooldown:
        remaining_min = int((cooldown - (now - last_sent)) / 60)
        logger.info(
            "[alert] Suppressed (cooldown %dm remaining): %s", remaining_min, subject
        )
        return
    cooldowns[subject] = now
    _save_cooldowns(cooldowns)

    to_addr   = os.getenv("ALERT_EMAIL_TO")
    smtp_host = os.getenv("ALERT_SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("ALERT_SMTP_PORT", "587"))
    smtp_user = os.getenv("ALERT_SMTP_USER")
    smtp_pass = os.getenv("ALERT_SMTP_PASS")

    if not all([to_addr, smtp_user, smtp_pass]):
        logger.warning(
            "[alert] Email not configured (ALERT_EMAIL_TO / ALERT_SMTP_USER / ALERT_SMTP_PASS) "
            "— skipping alert: %s", subject
        )
        return

    hostname = socket.gethostname()
    msg = EmailMessage()
    msg["Subject"] = f"[health-data-hub @ {hostname}] {subject}"
    msg["From"]    = smtp_user
    msg["To"]      = to_addr
    msg.set_content(body)

    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as smtp:
            smtp.starttls()
            smtp.login(smtp_user, smtp_pass)
            smtp.send_message(msg)
        logger.info("[alert] Email sent: %s → %s", subject, to_addr)
    except Exception as e:
        logger.warning("[alert] Failed to send email (%s): %s", subject, e)
