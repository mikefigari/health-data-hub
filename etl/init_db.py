from utils.db_connect import get_connection

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
