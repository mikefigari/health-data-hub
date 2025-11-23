from etl.init_db import initialize_database
from etl.transform.backfill_strava import backfill_all

def main():
    print("Initializing DB schema...")
    initialize_database()

    print("Running full Strava ETL backfill...")
    backfill_all()

    print("Backfill complete.")

if __name__ == "__main__":
    main()
