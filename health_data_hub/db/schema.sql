-- ============================================================
-- health_data_hub schema
-- Reflects live database structure.
-- Run via: python -m health_data_hub.etl.init_db
-- Safe to re-run: all statements use IF NOT EXISTS / OR REPLACE.
-- ============================================================


-- ------------------------------------------------------------
-- Strava: Raw workout metadata
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workouts_raw (
    id                      SERIAL PRIMARY KEY,
    source                  VARCHAR(50),
    external_id             VARCHAR(100) UNIQUE,
    start_time              TIMESTAMP,
    end_time                TIMESTAMP,
    sport_type              VARCHAR(50),
    distance_m              FLOAT,
    moving_s                INT,
    elapsed_s               INT,
    avg_speed               FLOAT,
    max_speed               FLOAT,
    avg_cadence             FLOAT,
    avg_hr                  FLOAT,
    max_hr                  FLOAT,
    avg_watts               FLOAT,
    max_watts               FLOAT,
    weighted_average_watts  FLOAT,
    kj                      FLOAT,
    device_watts            BOOLEAN,
    title                   TEXT,
    total_elevation_gain    FLOAT,
    has_heartrate           BOOLEAN,
    timezone                TEXT,
    raw_file_format         VARCHAR(10),
    raw_file_path           TEXT,
    inserted_at             TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Strava: Second-by-second stream samples
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workout_samples (
    id              SERIAL PRIMARY KEY,
    workout_id      INT REFERENCES workouts_raw(id) ON DELETE CASCADE,
    ts_seconds      INT,
    second_index    INT,
    heartrate       REAL,
    cadence         REAL,
    watts           REAL,
    velocity_mps    REAL
);

-- ------------------------------------------------------------
-- Strava: Computed summary per workout (NP, IF, TSS)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workout_summary (
    workout_id              INT PRIMARY KEY REFERENCES workouts_raw(id) ON DELETE CASCADE,
    distance_m              FLOAT,
    moving_s                INT,
    elapsed_s               INT,
    avg_speed               FLOAT,
    max_speed               FLOAT,
    avg_cadence             FLOAT,
    avg_hr                  FLOAT,
    max_hr                  FLOAT,
    avg_watts               FLOAT,
    max_watts               FLOAT,
    weighted_average_watts  FLOAT,
    kj                      FLOAT,
    device_watts            BOOLEAN,
    sport_type              VARCHAR(50),
    title                   TEXT,
    start_time              TIMESTAMP,
    total_elevation_gain    FLOAT,
    has_heartrate           BOOLEAN,
    timezone                TEXT,
    inserted_at             TIMESTAMP DEFAULT NOW(),
    np_watts                FLOAT,
    intensity_factor        FLOAT,
    tss_power               FLOAT
);

-- ------------------------------------------------------------
-- FTP history for per-workout TSS computation
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ftp_history (
    id              SERIAL PRIMARY KEY,
    effective_from  DATE NOT NULL,
    ftp_watts       FLOAT NOT NULL
);

-- ------------------------------------------------------------
-- Oura: Sleep records
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oura_sleep_raw (
    id                  BIGSERIAL PRIMARY KEY,
    sleep_id            TEXT UNIQUE,
    day                 DATE NOT NULL,
    bedtime_start       TIMESTAMPTZ,
    bedtime_end         TIMESTAMPTZ,
    total_sleep_sec     INT,
    time_in_bed_sec     INT,
    deep_sleep_sec      INT,
    light_sleep_sec     INT,
    rem_sleep_sec       INT,
    awake_sec           INT,
    efficiency          INT,
    latency_sec         INT,
    restless_periods    INT,
    lowest_hr           INT,
    avg_hr              DOUBLE PRECISION,
    avg_hrv             DOUBLE PRECISION,
    avg_breath          DOUBLE PRECISION,
    sleep_phase_5_min   TEXT,
    raw_json            JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Oura: Daily readiness scores and contributors
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oura_readiness_raw (
    id                  BIGSERIAL PRIMARY KEY,
    day                 DATE NOT NULL UNIQUE,
    score               INT,
    temp_dev            DOUBLE PRECISION,
    temp_trend_dev      DOUBLE PRECISION,
    r_activity_balance  INT,
    r_body_temp         INT,
    r_hrv_balance       INT,
    r_prev_day_activity INT,
    r_prev_night        INT,
    r_recovery_index    INT,
    r_resting_hr        INT,
    r_sleep_balance     INT,
    raw_json            JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Oura: HR + HRV samples (5-min intervals extracted from sleep)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oura_hr_samples (
    id          BIGSERIAL PRIMARY KEY,
    sleep_id    TEXT,
    "timestamp" TIMESTAMPTZ NOT NULL,
    bpm         DOUBLE PRECISION,
    hrv_rmssd   DOUBLE PRECISION,
    source      TEXT NOT NULL,
    raw_json    JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (sleep_id, "timestamp")
);

-- ------------------------------------------------------------
-- Oura: Daily activity summary (steps, calories, activity zones)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oura_activity_raw (
    id                  BIGSERIAL PRIMARY KEY,
    activity_id         TEXT UNIQUE,
    day                 DATE NOT NULL UNIQUE,
    steps               INT,
    cal_total           INT,
    cal_active          INT,
    inactive_sec        INT,
    low_activity_sec    INT,
    medium_activity_sec INT,
    high_activity_sec   INT,
    met_min_low         INT,
    met_min_medium      INT,
    met_min_high        INT,
    raw_json            JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Manual daily subjective state entries
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_physical_state (
    day              DATE PRIMARY KEY,
    overall_state    TEXT,
    energy_level     TEXT,
    body_signals     TEXT[],
    notes            TEXT,
    source           TEXT,
    entry_confidence TEXT,
    notion_page_id   TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE daily_physical_state
    ADD COLUMN IF NOT EXISTS notion_page_id TEXT;


-- ------------------------------------------------------------
-- Daily nutrition totals (MyFitnessPal)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nutrition_daily (
    day              DATE PRIMARY KEY,
    -- Actual daily totals
    calories         INT,
    protein_g        FLOAT,
    carbs_g          FLOAT,
    fat_g            FLOAT,
    fiber_g          FLOAT,
    sugar_g          FLOAT,
    sodium_mg        FLOAT,
    -- Goal values (from MFP daily goals)
    goal_calories    INT,
    goal_protein_g   FLOAT,
    goal_carbs_g     FLOAT,
    goal_fat_g       FLOAT,
    -- Meal breakdown (JSONB — queryable but avoids separate table)
    meals_json       JSONB,
    -- Metadata
    source           TEXT DEFAULT 'myfitnesspal',
    logged_complete  BOOLEAN,
    weight_kg        NUMERIC(5,2),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE nutrition_daily
    ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(5,2);


-- ------------------------------------------------------------
-- Planned workouts (athlete's training calendar)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planned_workouts (
    id              SERIAL PRIMARY KEY,
    planned_date    DATE NOT NULL,
    class_type      VARCHAR(100),
    duration_min    INTEGER,
    estimated_tss   NUMERIC(6,1),
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(planned_date, class_type)
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_raw_external_id
    ON workouts_raw (external_id);

CREATE INDEX IF NOT EXISTS idx_workout_samples_workout_id
    ON workout_samples (workout_id);

CREATE INDEX IF NOT EXISTS idx_ftp_history_effective_from
    ON ftp_history (effective_from DESC);


-- ============================================================
-- Views
-- ============================================================

-- Used by Notion sync and manual queries
CREATE OR REPLACE VIEW notion_workouts_view AS
SELECT
    workout_id,
    title                           AS name,
    avg_cadence,
    avg_hr                          AS avg_heart_rate,
    avg_speed * 2.23693629          AS avg_speed_mph,
    avg_watts,
    distance_m / 1609.344           AS distance_miles,
    moving_s                        AS duration_seconds,
    total_elevation_gain            AS elevation_meters,
    max_speed * 2.23693629          AS max_speed_mph,
    max_watts,
    np_watts                        AS normalized_power,
    tss_power                       AS tss,
    kj,
    start_time::DATE                AS workout_date,
    sport_type
FROM workout_summary;

-- Rolling 10-day training load and recovery dashboard
CREATE OR REPLACE VIEW analysis_daily_rollup_10d AS
WITH date_series AS (
    SELECT generate_series(
        CURRENT_DATE - INTERVAL '9 days',
        CURRENT_DATE::TIMESTAMP,
        INTERVAL '1 day'
    )::DATE AS day
),
training AS (
    SELECT
        ws.start_time::DATE         AS day,
        COUNT(*)                    AS workouts,
        SUM(ws.moving_s)::NUMERIC / 3600.0 AS training_hours,
        SUM(ws.tss_power)           AS tss,
        AVG(ws.intensity_factor)    AS avg_if
    FROM workout_summary ws
    JOIN workouts_raw wr ON wr.id = ws.workout_id
    WHERE ws.start_time::DATE >= CURRENT_DATE - INTERVAL '9 days'
    GROUP BY ws.start_time::DATE
),
sleep AS (
    SELECT
        day,
        SUM(total_sleep_sec)::NUMERIC / 3600.0 AS sleep_hours,
        CASE
            WHEN SUM(total_sleep_sec) > 0
            THEN SUM(efficiency * total_sleep_sec) / SUM(total_sleep_sec)
            ELSE NULL
        END AS sleep_score,
        CASE
            WHEN SUM(total_sleep_sec) > 0
            THEN SUM(avg_hr * total_sleep_sec::DOUBLE PRECISION) / SUM(total_sleep_sec)::DOUBLE PRECISION
            ELSE NULL
        END AS avg_sleep_hr,
        CASE
            WHEN SUM(total_sleep_sec) > 0
            THEN SUM(avg_hrv * total_sleep_sec::DOUBLE PRECISION) / SUM(total_sleep_sec)::DOUBLE PRECISION
            ELSE NULL
        END AS avg_sleep_hrv
    FROM oura_sleep_raw
    WHERE day >= CURRENT_DATE - INTERVAL '9 days'
      AND total_sleep_sec >= 2700
    GROUP BY day
),
readiness AS (
    SELECT
        day,
        score           AS readiness_score,
        r_resting_hr    AS resting_hr
    FROM oura_readiness_raw
    WHERE day >= CURRENT_DATE - INTERVAL '9 days'
)
SELECT
    d.day,
    COALESCE(t.workouts, 0)         AS workouts,
    COALESCE(t.training_hours, 0)   AS training_hours,
    COALESCE(t.tss, 0)              AS tss,
    t.avg_if,
    s.sleep_hours,
    s.sleep_score,
    r.readiness_score,
    r.resting_hr,
    s.avg_sleep_hrv                 AS hrv_rmssd
FROM date_series d
LEFT JOIN training  t ON t.day = d.day
LEFT JOIN sleep     s ON s.day = d.day
LEFT JOIN readiness r ON r.day = d.day
ORDER BY d.day;
