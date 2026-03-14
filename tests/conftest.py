"""
Test configuration.

Sets HEALTH_ENV=test before any package imports so that settings.py
loads test.env (dummy values) instead of the real dev/prod env files.
This allows pure logic tests to run on any machine without a database
or real API credentials.
"""

import os

# Must be set before any health_data_hub imports
os.environ["HEALTH_ENV"] = "test"
