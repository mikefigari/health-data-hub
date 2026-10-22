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
