"""
Run with:
python -m health_data_hub.integrations.oura.oura_test_fetch
"""

from .oura_api import fetch_sleep

if __name__ == "__main__":
    print("Testing Oura Sleep API fetch...")
    data = fetch_sleep("2025-01-01", "2025-01-10")
    print(data)
