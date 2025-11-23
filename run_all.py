from etl.init_db import initialize_database
from etl.transform.backfill_strava import backfill_all
from etl.transform.build_all_summaries import build_all_summaries
from etl.transform.update_tss import update_tss


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
