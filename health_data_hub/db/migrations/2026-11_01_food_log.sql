-- Migration 01: food_log, my_foods, my_food_aliases, food_log_audit, food_log_daily
-- and the nutrition_writer role (no login secret here; set it out-of-band).

DO $$
BEGIN
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.schema_migrations
                    WHERE name = '2026-11_01_food_log') THEN
            RAISE EXCEPTION 'migration 2026-11_01_food_log already applied';
        END IF;
    END IF;
END $$;

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

INSERT INTO public.schema_migrations (name) VALUES ('2026-11_01_food_log')
ON CONFLICT DO NOTHING;
