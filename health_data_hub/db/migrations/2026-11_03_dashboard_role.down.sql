-- Down for 2026-11_03_dashboard_role. Drops the dashboard_ro role and its grants
-- in this database; no table or view is touched.
DO $$
BEGIN
    IF to_regclass('public.schema_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE name = '2026-11_03_dashboard_role') THEN
        RAISE EXCEPTION 'migration 2026-11_03_dashboard_role is not applied';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_ro') THEN
        DROP OWNED BY dashboard_ro;
        DROP ROLE dashboard_ro;
    END IF;
END $$;

DELETE FROM public.schema_migrations WHERE name = '2026-11_03_dashboard_role';
