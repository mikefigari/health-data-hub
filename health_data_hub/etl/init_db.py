import sys
from pathlib import Path

from dotenv import load_dotenv

# Ensure absolute package imports work from any cwd
PROJECT_PARENT = Path(__file__).resolve().parents[2]
if str(PROJECT_PARENT) not in sys.path:
    sys.path.insert(0, str(PROJECT_PARENT))

from health_data_hub.utils.db_connect import get_connection  # noqa: E402

load_dotenv("config/dev.env")

def initialize_database():
    with open("db/schema.sql", "r") as f:
        schema_sql = f.read()

    conn = get_connection()
    cur = conn.cursor()
    cur.execute(schema_sql)
    conn.commit()
    cur.close()
    conn.close()

if __name__ == "__main__":
    initialize_database()
    print("Database initialized with schema.sql")
