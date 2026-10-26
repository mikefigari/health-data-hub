-- Down for 2026-11_01_food_log. Raises (dropping nothing) if food_log has rows.
-- The pg_trgm extension is left in place.
DO $$
BEGIN
    IF to_regclass('public.food_log') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.food_log) THEN
            RAISE EXCEPTION 'food_log has rows; refusing to drop';
        END IF;
    END IF;
END $$;

DROP VIEW IF EXISTS public.food_log_daily;
DROP TABLE IF EXISTS public.food_log_audit;
DROP TABLE IF EXISTS public.food_log;
DROP TABLE IF EXISTS public.my_food_aliases;
DROP TABLE IF EXISTS public.my_foods;
DROP FUNCTION IF EXISTS public.food_log_audit_fn();
DROP FUNCTION IF EXISTS public.touch_updated_at();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nutrition_writer') THEN
        DROP OWNED BY nutrition_writer;
        DROP ROLE nutrition_writer;
    END IF;
END $$;

DELETE FROM public.schema_migrations WHERE name = '2026-11_01_food_log';
