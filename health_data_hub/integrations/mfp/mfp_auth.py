"""
MyFitnessPal authentication via browser cookies.

Two-tier strategy:
  Tier 1 — Cookie file (mfp_cookies.txt): works on both Windows and Pi.
            Export once from Windows with export_cookies(), then scp to Pi.
  Tier 2 — Live browser fallback (Windows only): used if cookie file absent.

Re-auth instructions (when cookies expire ~30-90 days):
  1. Log in to myfitnesspal.com in Chrome or Firefox on Windows.
  2. Run: python -m health_data_hub.integrations.mfp.mfp_auth
  3. scp health_data_hub/config/mfp_cookies.txt pi@<host>:~/health_data_hub/health_data_hub/config/
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from http.cookiejar import MozillaCookieJar
from pathlib import Path

import requests as _requests
import myfitnesspal
import myfitnesspal.client as _mfp_client

from health_data_hub.config.settings import MFP_USERNAME, MFP_COOKIE_FILE

logger = logging.getLogger(__name__)

_MFP_DOMAINS = ("myfitnesspal.com",)
_COOKIE_AGE_WARN_DAYS = 25


def export_cookies() -> None:
    """
    Read MFP cookies from the live browser and save to mfp_cookies.txt.
    Run this on Windows after logging in to myfitnesspal.com.
    """
    try:
        import browser_cookie3
    except ImportError:
        raise RuntimeError(
            "browser_cookie3 is required for cookie export. "
            "Install it with: pip install browser-cookie3"
        )

    jar = MozillaCookieJar(str(MFP_COOKIE_FILE))

    cookies_found = 0
    for loader in (browser_cookie3.chrome, browser_cookie3.edge, browser_cookie3.firefox):
        try:
            for cookie in loader(domain_name="myfitnesspal.com"):
                jar.set_cookie(cookie)
                cookies_found += 1
        except Exception as e:
            logger.debug("Browser loader %s failed: %s", loader.__name__, e)

    if not cookies_found:
        raise RuntimeError(
            "No MFP cookies found in Chrome or Firefox. "
            "Make sure you are logged in to myfitnesspal.com and try again."
        )

    jar.save(ignore_discard=True, ignore_expires=True)
    logger.info("Saved %d MFP cookies to %s", cookies_found, MFP_COOKIE_FILE)
    print(f"Saved {cookies_found} MFP cookies to {MFP_COOKIE_FILE}")


def _check_cookie_age(cookie_file: Path) -> None:
    """Warn if the cookie file is older than _COOKIE_AGE_WARN_DAYS days."""
    mtime = cookie_file.stat().st_mtime
    age_days = (time.time() - mtime) / 86400
    if age_days > _COOKIE_AGE_WARN_DAYS:
        logger.warning(
            "MFP cookie file is %.0f days old (> %d day warning threshold). "
            "Cookies may have expired. Re-run: python -m health_data_hub.integrations.mfp.mfp_auth",
            age_days,
            _COOKIE_AGE_WARN_DAYS,
        )


_FIREFOX_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) "
    "Gecko/20100101 Firefox/136.0"
)


def _build_client(cookiejar) -> myfitnesspal.Client:
    """
    Instantiate myfitnesspal.Client using a plain requests.Session.

    cloudscraper (used internally by the library) modifies the TLS fingerprint
    in a way Cloudflare detects and blocks. Replacing create_scraper with a
    factory that returns a plain requests.Session with a matching Firefox UA
    bypasses this while keeping the session cookies intact.
    """
    import cloudscraper as _cs

    def _plain_session_factory(sess=None, **kwargs):
        s = sess or _requests.Session()
        s.headers["User-Agent"] = _FIREFOX_UA
        return s

    original = _cs.create_scraper
    _cs.create_scraper = _plain_session_factory
    try:
        return myfitnesspal.Client(cookiejar=cookiejar)
    finally:
        _cs.create_scraper = original


def get_client() -> myfitnesspal.Client:
    """
    Return an authenticated myfitnesspal.Client.

    Tries cookie file first, then live browser, then raises RuntimeError.
    """
    if not MFP_USERNAME:
        raise RuntimeError(
            "MFP_USERNAME is not set. Add MFP_USERNAME=<username> to your env file."
        )

    # --- Tier 1: cookie file ---
    if MFP_COOKIE_FILE.exists():
        _check_cookie_age(MFP_COOKIE_FILE)
        jar = MozillaCookieJar(str(MFP_COOKIE_FILE))
        jar.load(ignore_discard=True, ignore_expires=True)
        logger.debug("Loaded MFP cookies from %s", MFP_COOKIE_FILE)
        return _build_client(jar)

    # --- Tier 2: live browser fallback ---
    logger.warning(
        "mfp_cookies.txt not found at %s — falling back to live browser cookies. "
        "This will not work on a headless Pi.",
        MFP_COOKIE_FILE,
    )
    try:
        import browser_cookie3
    except ImportError:
        raise RuntimeError(
            "mfp_cookies.txt not found and browser_cookie3 is not installed. "
            "Run: python -m health_data_hub.integrations.mfp.mfp_auth on Windows first."
        )

    for loader in (browser_cookie3.chrome, browser_cookie3.edge, browser_cookie3.firefox):
        try:
            jar = loader(domain_name="myfitnesspal.com")
            client = _build_client(jar)
            logger.info("Authenticated via live %s cookies", loader.__name__)
            return client
        except Exception as e:
            logger.debug("Live browser loader %s failed: %s", loader.__name__, e)

    raise RuntimeError(
        "Could not authenticate with MyFitnessPal. "
        "Log in to myfitnesspal.com in Chrome or Firefox, then run: "
        "python -m health_data_hub.integrations.mfp.mfp_auth"
    )


if __name__ == "__main__":
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()
    export_cookies()
