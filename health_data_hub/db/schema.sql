-- Raw Strava workouts with rich metadata
CREATE TABLE IF NOT EXISTS workouts_raw (
    id SERIAL PRIMARY KEY,
    source VARCHAR(50),
    external_id VARCHAR(100) UNIQUE,
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    sport_type VARCHAR(50),
    distance_m FLOAT,
    moving_s INT,
    elapsed_s INT,
    avg_speed FLOAT,
    max_speed FLOAT,
    avg_cadence FLOAT,
    avg_hr FLOAT,
    max_hr FLOAT,
    avg_watts FLOAT,
    max_watts FLOAT,
    weighted_average_watts FLOAT,
    kj FLOAT,
    device_watts BOOLEAN,
    title TEXT,
    total_elevation_gain FLOAT,
    has_heartrate BOOLEAN,
    timezone TEXT,
    raw_file_format VARCHAR(10),
    raw_file_path TEXT,
    inserted_at TIMESTAMP DEFAULT NOW()
);

-- Second-by-second samples for each workout
CREATE TABLE IF NOT EXISTS workout_samples (
    id SERIAL PRIMARY KEY,
    workout_id INT REFERENCES workouts_raw(id) ON DELETE CASCADE,
    ts TIMESTAMP NOT NULL,
    heartrate REAL,
    cadence REAL,
    watts REAL,
    speed REAL
);

-- Summary metrics per workout
CREATE TABLE IF NOT EXISTS workout_summary (
    workout_id INT PRIMARY KEY REFERENCES workouts_raw(id) ON DELETE CASCADE,
    distance_m FLOAT,
    moving_s INT,
    elapsed_s INT,
    avg_speed FLOAT,
    max_speed FLOAT,
    avg_cadence FLOAT,
    avg_hr FLOAT,
    max_hr FLOAT,
    avg_watts FLOAT,
    max_watts FLOAT,
    weighted_average_watts FLOAT,
    kj FLOAT,
    device_watts BOOLEAN,
    sport_type VARCHAR(50),
    title TEXT,
    start_time TIMESTAMP,
    total_elevation_gain FLOAT,
    has_heartrate BOOLEAN,
    timezone TEXT,
    inserted_at TIMESTAMP DEFAULT NOW(),
    np_watts FLOAT,
    intensity_factor FLOAT,
    tss_power FLOAT
);

-- FTP history to compute TSS per workout date
CREATE TABLE IF NOT EXISTS ftp_history (
    id SERIAL PRIMARY KEY,
    effective_from DATE NOT NULL,
    ftp_watts FLOAT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_raw_external_id
    ON workouts_raw (external_id);

CREATE INDEX IF NOT EXISTS idx_workout_samples_workout_id
    ON workout_samples (workout_id);

CREATE INDEX IF NOT EXISTS idx_ftp_history_effective_from
    ON ftp_history (effective_from DESC);
