-- Migration 03: read-only dashboard_ro role for the weight + nutrition dashboard.
-- SELECT on the five dashboard sources only; workout_summary per column (never
-- title). No default privileges. The login secret is set out-of-band.

DO $$
BEGIN
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.schema_migrations
                    WHERE name = '2026-11_03_dashboard_role') THEN
            RAISE EXCEPTION 'migration 2026-11_03_dashboard_role already applied';
        END IF;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_ro') THEN
        CREATE ROLE dashboard_ro LOGIN CONNECTION LIMIT 3;
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO dashboard_ro', current_database());
END $$;
ALTER ROLE dashboard_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 3;
ALTER ROLE dashboard_ro SET default_transaction_read_only = on;
ALTER ROLE dashboard_ro SET statement_timeout = '5s';
ALTER ROLE dashboard_ro SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE dashboard_ro SET search_path = public;
GRANT USAGE ON SCHEMA public TO dashboard_ro;

GRANT SELECT ON public.body_weight_daily TO dashboard_ro;
GRANT SELECT ON public.nutrition_daily TO dashboard_ro;
GRANT SELECT ON public.nutrition_goals TO dashboard_ro;
GRANT SELECT ON public.ftp_history TO dashboard_ro;
GRANT SELECT (start_time, sport_type, device_watts, kj) ON public.workout_summary TO dashboard_ro;

INSERT INTO public.schema_migrations (name) VALUES ('2026-11_03_dashboard_role')
ON CONFLICT DO NOTHING;
