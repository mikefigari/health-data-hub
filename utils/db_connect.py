import os
import psycopg2
from dotenv import load_dotenv

def get_connection():
    # Load environment variables from config/dev.env
    env_path = os.path.join(os.path.dirname(__file__), "..", "config", "dev.env")
    load_dotenv(env_path)

    conn = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD")
    )
    return conn
