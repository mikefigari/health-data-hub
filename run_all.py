import sys
from pathlib import Path

from dotenv import load_dotenv

# Ensure absolute imports work from any execution directory
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


from health_data_hub.etl.init_db import initialize_database  # noqa: E402
from health_data_hub.etl.transform.backfill_strava import backfill_all  # noqa: E402
from health_data_hub.etl.transform.build_all_summaries import build_all_summaries  # noqa: E402
from health_data_hub.etl.transform.update_tss import update_tss  # noqa: E402

load_dotenv(PROJECT_PARENT / "health_data_hub" / "config" / "dev.env")


def main():
    print("Initializing DB schema...")
    initialize_database()

    print("Running full Strava ETL backfill...")
    backfill_all()

    print("Building workout summaries...")
    build_all_summaries()

    print("Computing TSS for all workouts...")
    update_tss()

    print("All ETL steps complete.")


if __name__ == "__main__":
    main()
