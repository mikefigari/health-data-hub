from etl.extract.strava_api import get_recent_activities
from pprint import pprint

acts = get_recent_activities(3)

for a in acts:
    print("\nID:", a['id'], " Name:", a['name'])
    pprint(a)
