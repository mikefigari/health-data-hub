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
-- Daily nutrition totals, frozen (MyFitnessPal, then Apple Health).
-- Readers use VIEW nutrition_daily (defined below, after food_log).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nutrition_daily_legacy (
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

ALTER TABLE nutrition_daily_legacy
    ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(5,2);

COMMENT ON TABLE nutrition_daily_legacy IS
    'Frozen: MFP (2025-12..2026-03) and Apple Health (2026-03..2026-10) daily totals. New days come from food_log via VIEW nutrition_daily.';


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

-- ------------------------------------------------------------
-- Strava: Sync audit log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS strava_sync_log (
    id                  SERIAL PRIMARY KEY,
    triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    status              TEXT NOT NULL,       -- 'success' | 'error' | 'no_data'
    activities_found    INTEGER,
    activities_written  INTEGER,
    error_message       TEXT
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

-- ------------------------------------------------------------
-- Monitoring: quality check run history
-- Created automatically by storage.save_report() on first use.
-- Included here so init_db.py also provisions it on fresh installs.
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS monitoring;

CREATE TABLE IF NOT EXISTS monitoring.quality_check_runs (
    id            SERIAL PRIMARY KEY,
    run_id        UUID        NOT NULL,
    run_at        TIMESTAMPTZ NOT NULL,
    check_name    TEXT        NOT NULL,
    severity      TEXT        NOT NULL,   -- 'warn' | 'error'
    passed        BOOLEAN     NOT NULL,
    message       TEXT,
    rows_affected INT         DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_qcr_run_at
    ON monitoring.quality_check_runs (run_at DESC);

CREATE INDEX IF NOT EXISTS idx_qcr_check_name
    ON monitoring.quality_check_runs (check_name, run_at DESC);

-- ------------------------------------------------------------
-- Body measurements (Renpho scale -> Apple Health -> Health Auto Export)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS body_measurements (
    id             BIGSERIAL PRIMARY KEY,
    measured_at    TIMESTAMPTZ NOT NULL,
    local_day      DATE NOT NULL,           -- calendar day in the UTC offset HAE reported
    source         TEXT NOT NULL,           -- 'apple_health'
    source_device  TEXT,                    -- per-sample source from HAE, if present
    weight_kg      NUMERIC(5,2),
    body_fat_pct   NUMERIC(4,1),
    lean_mass_kg   NUMERIC(5,2),
    muscle_mass_kg NUMERIC(5,2),            -- not in HealthKit; stays NULL
    water_pct      NUMERIC(4,1),            -- not in HealthKit; stays NULL
    bmi            NUMERIC(4,1),
    raw_json       JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, measured_at)
);

CREATE INDEX IF NOT EXISTS idx_body_measurements_local_day
    ON body_measurements (local_day);

CREATE OR REPLACE VIEW body_weight_daily AS
SELECT DISTINCT ON (local_day)
    local_day AS day,
    weight_kg,
    body_fat_pct,
    lean_mass_kg,
    bmi,
    measured_at,
    count(*) OVER (PARTITION BY local_day) AS n_weighins
FROM body_measurements
WHERE weight_kg IS NOT NULL
ORDER BY local_day, measured_at;           -- first weigh-in of the day

-- ------------------------------------------------------------
-- Food log (mirrors migrations/2026-11_01_food_log.sql)
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Shared trigger fn: bump updated_at on UPDATE
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- ------------------------------------------------------------
-- Favorites / recurring foods
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.my_foods (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    serving_qty    NUMERIC(8,2) NOT NULL DEFAULT 1 CHECK (serving_qty > 0),
    serving_unit   TEXT NOT NULL DEFAULT 'serving' CHECK (length(serving_unit) <= 40),
    serving_grams  NUMERIC(7,1) CHECK (serving_grams > 0 AND serving_grams <= 5000),
    -- nutrients for ONE serving as defined above
    calories       NUMERIC(7,1) NOT NULL CHECK (calories  BETWEEN 0 AND 5000),
    protein_g      NUMERIC(6,1) NOT NULL CHECK (protein_g BETWEEN 0 AND 500),
    carbs_g        NUMERIC(6,1) NOT NULL CHECK (carbs_g   BETWEEN 0 AND 1000),
    fat_g          NUMERIC(6,1) NOT NULL CHECK (fat_g     BETWEEN 0 AND 500),
    fiber_g        NUMERIC(6,1) CHECK (fiber_g   BETWEEN 0 AND 200),
    sugar_g        NUMERIC(6,1) CHECK (sugar_g   BETWEEN 0 AND 1000),
    sodium_mg      NUMERIC(7,1) CHECK (sodium_mg BETWEEN 0 AND 20000),
    confidence     TEXT NOT NULL CHECK (confidence IN ('high','med','low')),
    basis          TEXT NOT NULL CHECK (basis IN ('label','usda','recipe','restaurant','estimate')),
    fdc_id         INTEGER,                       -- soft ref to a USDA food (no FK)
    notes          TEXT CHECK (length(notes) <= 500),
    use_count      INTEGER NOT NULL DEFAULT 0,
    last_used_at   TIMESTAMPTZ,
    archived_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS my_foods_name_active_uq
    ON public.my_foods (lower(name)) WHERE archived_at IS NULL;
CREATE OR REPLACE TRIGGER my_foods_touch BEFORE UPDATE ON public.my_foods
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.my_food_aliases (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    my_food_id  BIGINT NOT NULL REFERENCES public.my_foods(id) ON DELETE CASCADE,
    alias       TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 120),
    alias_norm  TEXT GENERATED ALWAYS AS
                (lower(regexp_replace(btrim(alias), '\s+', ' ', 'g'))) STORED,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS my_food_aliases_norm_uq ON public.my_food_aliases (alias_norm);
CREATE INDEX IF NOT EXISTS my_food_aliases_trgm ON public.my_food_aliases USING gin (alias_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS my_food_aliases_food ON public.my_food_aliases (my_food_id);
-- save_favorite always inserts the favorite's name as an alias too.

-- ------------------------------------------------------------
-- One row per item eaten
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.food_log (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    eaten_at       TIMESTAMPTZ NOT NULL,
    day            DATE GENERATED ALWAYS AS
                   ((eaten_at AT TIME ZONE 'America/Los_Angeles')::date) STORED,
    meal           TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
    description    TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
    quantity       NUMERIC(8,2) CHECK (quantity > 0),
    unit           TEXT CHECK (length(unit) <= 40),
    grams          NUMERIC(7,1) CHECK (grams > 0 AND grams <= 5000),
    calories       NUMERIC(7,1) NOT NULL CHECK (calories  BETWEEN 0 AND 5000),
    protein_g      NUMERIC(6,1) NOT NULL CHECK (protein_g BETWEEN 0 AND 500),
    carbs_g        NUMERIC(6,1) NOT NULL CHECK (carbs_g   BETWEEN 0 AND 1000),
    fat_g          NUMERIC(6,1) NOT NULL CHECK (fat_g     BETWEEN 0 AND 500),
    fiber_g        NUMERIC(6,1) CHECK (fiber_g   BETWEEN 0 AND 200),     -- NULL = unknown, not 0
    sugar_g        NUMERIC(6,1) CHECK (sugar_g   BETWEEN 0 AND 1000),
    sodium_mg      NUMERIC(7,1) CHECK (sodium_mg BETWEEN 0 AND 20000),
    confidence     TEXT NOT NULL CHECK (confidence IN ('high','med','low')),
    match_source   TEXT NOT NULL CHECK (match_source IN ('favorite','usda','restaurant','estimate')),
    my_food_id     BIGINT REFERENCES public.my_foods(id) ON DELETE RESTRICT,
    fdc_id         INTEGER,                       -- soft ref
    ref_label      TEXT CHECK (length(ref_label) <= 200),
    created_via    TEXT NOT NULL CHECK (created_via IN ('claude_mcp','voice_n8n','manual','import')),
    request_id     UUID,                          -- idempotency key for one log_food call
    request_line   SMALLINT,                      -- item index within that call
    notes          TEXT CHECK (length(notes) <= 500),
    deleted_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT food_log_favorite_ref CHECK (match_source <> 'favorite' OR my_food_id IS NOT NULL),
    CONSTRAINT food_log_usda_ref     CHECK (match_source <> 'usda'     OR fdc_id     IS NOT NULL),
    CONSTRAINT food_log_request_uq   UNIQUE (request_id, request_line)
);
CREATE INDEX IF NOT EXISTS food_log_day_live  ON public.food_log (day) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS food_log_eaten_at  ON public.food_log (eaten_at);
CREATE INDEX IF NOT EXISTS food_log_my_food   ON public.food_log (my_food_id) WHERE my_food_id IS NOT NULL;
CREATE OR REPLACE TRIGGER food_log_touch BEFORE UPDATE ON public.food_log
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ------------------------------------------------------------
-- Audit trail (every insert/update/soft-delete/restore)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.food_log_audit (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    food_log_id  BIGINT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('insert','update','soft_delete','restore')),
    old_row      JSONB,
    new_row      JSONB,
    changed_by   TEXT NOT NULL DEFAULT current_user,
    changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS food_log_audit_entry ON public.food_log_audit (food_log_id, changed_at);

CREATE OR REPLACE FUNCTION public.food_log_audit_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.food_log_audit (food_log_id, action, new_row)
        VALUES (NEW.id, 'insert', to_jsonb(NEW));
    ELSE
        INSERT INTO public.food_log_audit (food_log_id, action, old_row, new_row)
        VALUES (NEW.id,
                CASE WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'soft_delete'
                     WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN 'restore'
                     ELSE 'update' END,
                to_jsonb(OLD), to_jsonb(NEW));
    END IF;
    RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER food_log_audit_trg AFTER INSERT OR UPDATE ON public.food_log
    FOR EACH ROW EXECUTE FUNCTION public.food_log_audit_fn();

-- ------------------------------------------------------------
-- Live per-day totals
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.food_log_daily AS
SELECT
    day,
    round(sum(calories))::int                       AS calories,
    sum(protein_g)::double precision                AS protein_g,
    sum(carbs_g)::double precision                  AS carbs_g,
    sum(fat_g)::double precision                    AS fat_g,
    sum(fiber_g)::double precision                  AS fiber_g,     -- NULL only if all items NULL
    sum(sugar_g)::double precision                  AS sugar_g,
    sum(sodium_mg)::double precision                AS sodium_mg,
    count(*)                                        AS items,
    count(*) FILTER (WHERE fiber_g IS NULL OR sugar_g IS NULL OR sodium_mg IS NULL)
                                                    AS items_missing_micros,
    count(*) FILTER (WHERE confidence = 'low')      AS low_confidence_items,
    round(coalesce(sum(calories) FILTER (WHERE confidence = 'low' OR match_source = 'estimate'), 0)
          / nullif(sum(calories), 0), 2)            AS estimated_calorie_share,
    min(created_at)                                 AS created_at,
    max(updated_at)                                 AS updated_at
FROM public.food_log
WHERE deleted_at IS NULL
GROUP BY day;

-- ------------------------------------------------------------
-- Least-privilege writer role (login secret is set out-of-band)
-- ------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nutrition_writer') THEN
        CREATE ROLE nutrition_writer LOGIN CONNECTION LIMIT 3;
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO nutrition_writer', current_database());
END $$;
ALTER ROLE nutrition_writer SET statement_timeout = '5s';
ALTER ROLE nutrition_writer SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE nutrition_writer SET search_path = public;
GRANT USAGE ON SCHEMA public TO nutrition_writer;

GRANT SELECT, INSERT ON public.food_log TO nutrition_writer;
GRANT UPDATE (eaten_at, meal, description, quantity, unit, grams,
              calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
              confidence, match_source, my_food_id, fdc_id, ref_label, notes, deleted_at)
    ON public.food_log TO nutrition_writer;                 -- no id/created_via/request_* edits
GRANT SELECT, INSERT, UPDATE ON public.my_foods TO nutrition_writer;
GRANT SELECT, INSERT, DELETE ON public.my_food_aliases TO nutrition_writer;
GRANT INSERT ON public.food_log_audit TO nutrition_writer;  -- trigger writes; no SELECT needed
GRANT SELECT ON public.food_log_daily TO nutrition_writer;
-- No DELETE on food_log/my_foods. No access to any other table.
-- claude_readonly gets SELECT on new public tables/views via its default privileges.

-- ------------------------------------------------------------
-- Goals, day status and VIEW nutrition_daily
-- (mirrors migrations/2026-11_02_nutrition_daily_view.sql)
-- ------------------------------------------------------------
-- Goals (D5): goal_calories = base_calories + cycling_kj_factor * powered Ride kJ.
-- No Oura input.
CREATE TABLE IF NOT EXISTS public.nutrition_goals (
    effective_from     DATE PRIMARY KEY,
    target_weight_kg   NUMERIC(5,1) CHECK (target_weight_kg BETWEEN 30 AND 300),
    base_calories      INT NOT NULL CHECK (base_calories BETWEEN 800 AND 6000),
    cycling_kj_factor  NUMERIC(3,2) NOT NULL DEFAULT 1.00 CHECK (cycling_kj_factor BETWEEN 0 AND 1.50),
    protein_g          NUMERIC(6,1) CHECK (protein_g BETWEEN 0 AND 500),
    notes              TEXT CHECK (length(notes) <= 500),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.nutrition_goals
       (effective_from, target_weight_kg, base_calories, cycling_kj_factor, protein_g, notes)
VALUES ('2026-10-25', 100.0, 2620, 1.00, 180,
        'Seed (PLAN.md D5): 100 kg target; goal = base + powered Ride kJ')
ON CONFLICT (effective_from) DO NOTHING;

-- Per-day "I am done logging" flag; feeds nutrition_daily.logged_complete
CREATE TABLE IF NOT EXISTS public.nutrition_day_status (
    day              DATE PRIMARY KEY,
    logged_complete  BOOLEAN NOT NULL,
    note             TEXT CHECK (length(note) <= 300),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER nutrition_day_status_touch BEFORE UPDATE ON public.nutrition_day_status
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Same name, same columns, same order, same types as the old table.
-- A day with any live food_log row returns food_log totals; otherwise the
-- legacy row. Never both.
CREATE OR REPLACE VIEW public.nutrition_daily AS
WITH meals AS (
    SELECT day,
           jsonb_object_agg(CASE meal WHEN 'snack' THEN 'snacks' ELSE meal END,   -- MFP key shape
                            jsonb_build_object('calories',  round(cal, 1),
                                               'protein_g', round(p, 1),
                                               'carbs_g',   round(c, 1),
                                               'fat_g',     round(f, 1))) AS meals_json
    FROM (SELECT day, meal, sum(calories) AS cal, sum(protein_g) AS p,
                 sum(carbs_g) AS c, sum(fat_g) AS f
            FROM public.food_log
           WHERE deleted_at IS NULL
           GROUP BY day, meal) m
    GROUP BY day
),
rides AS (
    SELECT (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date AS day, sum(kj) AS kj
      FROM public.workout_summary
     WHERE sport_type = 'Ride' AND device_watts AND kj > 0
     GROUP BY (start_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date
)
SELECT
    fl.day,
    fl.calories,
    fl.protein_g, fl.carbs_g, fl.fat_g, fl.fiber_g, fl.sugar_g, fl.sodium_mg,
    (g.base_calories
       + round(g.cycling_kj_factor * coalesce(r.kj, 0)::numeric)::int
    )::int                                  AS goal_calories,
    g.protein_g::double precision           AS goal_protein_g,
    NULL::double precision                  AS goal_carbs_g,
    NULL::double precision                  AS goal_fat_g,
    m.meals_json,
    'food_log'::text                        AS source,
    s.logged_complete,
    NULL::numeric(5,2)                      AS weight_kg,
    fl.created_at,
    fl.updated_at
FROM public.food_log_daily fl
LEFT JOIN meals m                       ON m.day = fl.day
LEFT JOIN rides r                       ON r.day = fl.day
LEFT JOIN public.nutrition_day_status s ON s.day = fl.day
LEFT JOIN LATERAL (
    SELECT g0.base_calories, g0.cycling_kj_factor, g0.protein_g
      FROM public.nutrition_goals g0
     WHERE g0.effective_from <= fl.day
     ORDER BY g0.effective_from DESC
     LIMIT 1
) g ON true
UNION ALL
SELECT l.day, l.calories, l.protein_g, l.carbs_g, l.fat_g, l.fiber_g, l.sugar_g, l.sodium_mg,
       l.goal_calories, l.goal_protein_g, l.goal_carbs_g, l.goal_fat_g,
       l.meals_json, l.source, l.logged_complete, l.weight_kg, l.created_at, l.updated_at
FROM public.nutrition_daily_legacy l
WHERE NOT EXISTS (SELECT 1 FROM public.food_log f
                   WHERE f.day = l.day AND f.deleted_at IS NULL);

-- nutrition_writer: day status upserts, goal and view reads. It reads legacy rows through the view's owner rights.
GRANT SELECT, INSERT, UPDATE ON public.nutrition_day_status TO nutrition_writer;
GRANT SELECT ON public.nutrition_goals TO nutrition_writer;
GRANT SELECT ON public.nutrition_daily TO nutrition_writer;

-- ------------------------------------------------------------
-- Migration ledger (mirrors migrations/2026-11_00_migration_ledger.sql)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.schema_migrations (name)
VALUES ('2026-10_body_measurements'), ('2026-11_00_migration_ledger'),
       ('2026-11_01_food_log'), ('2026-11_02_nutrition_daily_view')
ON CONFLICT DO NOTHING;
