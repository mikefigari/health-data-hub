-- Down for 2026-11_02_nutrition_daily_view. Restores table nutrition_daily
-- (rows untouched) and drops the goals/day-status tables. food_log is left
-- alone, so no logged food is lost; day-status flags and goals are dropped.
DO $$
BEGIN
    IF to_regclass('public.nutrition_daily_legacy') IS NULL THEN
        RAISE EXCEPTION 'migration 2026-11_02_nutrition_daily_view is not applied (no nutrition_daily_legacy)';
    END IF;
END $$;

DROP VIEW IF EXISTS public.nutrition_daily;
ALTER TABLE public.nutrition_daily_legacy RENAME TO nutrition_daily;
ALTER INDEX public.nutrition_daily_legacy_pkey RENAME TO nutrition_daily_pkey;
COMMENT ON TABLE public.nutrition_daily IS NULL;

DROP TABLE IF EXISTS public.nutrition_day_status;
DROP TABLE IF EXISTS public.nutrition_goals;

DELETE FROM public.schema_migrations WHERE name = '2026-11_02_nutrition_daily_view';
