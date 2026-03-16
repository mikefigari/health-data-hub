"""
Centralized logging configuration for health_data_hub.

Call setup() once at the entry point of each scheduler or script.
All modules then use logging.getLogger(__name__) to get a named logger
that inherits this configuration.

Usage in entry points:
    from health_data_hub.utils.logging_config import setup_logging
    setup_logging()

Usage in modules:
    import logging
    logger = logging.getLogger(__name__)
    logger.info("...")
"""

import logging
import sys


def setup_logging(level: int = logging.INFO) -> None:
    """
    Configure root logger with a timestamped format to stdout.
    Safe to call multiple times — handlers are only added once.
    """
    root = logging.getLogger()

    if root.handlers:
        return  # already configured

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))

    root.addHandler(handler)
    root.setLevel(level)
