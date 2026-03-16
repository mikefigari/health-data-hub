from pathlib import Path

from health_data_hub.utils.db_connect import get_connection

SCHEMA_FILE = Path(__file__).resolve().parents[1] / "db" / "schema.sql"


def initialize_database():
    with open(SCHEMA_FILE, "r") as f:
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
