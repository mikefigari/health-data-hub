from etl.extract.strava_api import get_activity_details
import json

def dump_activity(activity_id, filename):
    print(f"Fetching activity {activity_id}...")
    data = get_activity_details(activity_id)

    with open(filename, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Saved: {filename}")


if __name__ == "__main__":
    # Outdoor ride
    dump_activity("15723230606", "activity_outdoor.json")

    # Peloton ride
    dump_activity("16505927929", "activity_peloton.json")
