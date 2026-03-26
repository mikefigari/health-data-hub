"""
Email alerting utility.

Sends a plain-text alert email via SMTP (STARTTLS).
Configure in your env file:

    ALERT_EMAIL_TO    = you@example.com
    ALERT_SMTP_HOST   = smtp.gmail.com
    ALERT_SMTP_PORT   = 587
    ALERT_SMTP_USER   = you@gmail.com
    ALERT_SMTP_PASS   = <Gmail app password>

If any of these are unset the alert is skipped and a warning is logged —
the caller is never broken by a missing email config.
"""

from __future__ import annotations

import logging
import os
import smtplib
import socket
from email.message import EmailMessage

logger = logging.getLogger(__name__)


def send_alert(subject: str, body: str) -> None:
    """Send a plain-text alert email.  Never raises — logs a warning on failure."""
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
