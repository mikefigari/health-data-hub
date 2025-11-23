import os
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


def get_connection():
    """
    Return a Postgres connection using settings from config/dev.env.
    """
    env_path = Path(__file__).resolve().parents[1] / "config" / "dev.env"
    load_dotenv(env_path)

    conn = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )
    return conn
