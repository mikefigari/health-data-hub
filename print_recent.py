import sys
from pathlib import Path
from pprint import pprint

# Ensure absolute imports work from any execution directory
PROJECT_PARENT = Path(__file__).resolve().parents[1]
if str(PROJECT_PARENT) not in sys.path:
    sys.path.insert(0, str(PROJECT_PARENT))

from health_data_hub.etl.extract.strava_api import get_recent_activities  # noqa: E402

acts = get_recent_activities(3)

for a in acts:
    print("\nID:", a['id'], " Name:", a['name'])
    pprint(a)
