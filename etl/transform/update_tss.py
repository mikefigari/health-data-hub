from utils.db_connect import get_connection

def update_tss():
    conn = get_connection()
    cur = conn.cursor()

    print("Updating TSS for all workouts...")
    cur.execute("CALL update_all_tss();")
    conn.commit()

    cur.close()
    conn.close()
    print("TSS update complete.")
