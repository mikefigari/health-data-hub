-- Raw workout storage: one row per workout, with optional raw file
CREATE TABLE IF NOT EXISTS workouts_raw (
    workout_id SERIAL PRIMARY KEY,
    source VARCHAR(50),                     -- strava peloton etc
    source_workout_key VARCHAR(100),        -- the id from that service
    start_time_utc TIMESTAMP,
    end_time_utc TIMESTAMP,
    sport VARCHAR(50),
    raw_file_format VARCHAR(10),            -- tcx fit etc
    raw_blob BYTEA                          -- optional raw file bytes
);

-- Second by second samples for each workout
CREATE TABLE IF NOT EXISTS workout_samples (
    sample_id SERIAL PRIMARY KEY,
    workout_id INT REFERENCES workouts_raw(workout_id) ON DELETE CASCADE,
    sample_time_utc TIMESTAMP,
    power_w INT,
    heart_rate INT,
    cadence INT,
    speed_mps FLOAT
);

-- Summary metrics per workout
CREATE TABLE IF NOT EXISTS workout_summary (
    workout_id INT PRIMARY KEY REFERENCES workouts_raw(workout_id) ON DELETE CASCADE,
    duration_sec INT,
    distance_m FLOAT,
    avg_power_w FLOAT,
    normalized_power_w FLOAT,
    intensity_factor FLOAT,
    tss_power FLOAT
);
