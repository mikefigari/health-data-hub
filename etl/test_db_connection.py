import os
import sys

# Make sure the project root is on the Python path
# so "utils" can be imported when this file is run from the etl folder
project_root = os.path.dirname(os.path.dirname(__file__))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

print("Starting DB connection test...")

from utils.db_connect import get_connection

try:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT version();")
    version = cur.fetchone()
    print("Connected successfully!")
    print("Postgres version:", version[0])

    cur.close()
    conn.close()

except Exception as e:
    print("Connection failed!")
    import traceback
    traceback.print_exc()
