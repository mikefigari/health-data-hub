-- Migration ledger: public.schema_migrations (name PK, applied_at).
--
-- GUARD PATTERN (copy this into every migration):
--   1. The first statement is a DO block that raises "migration <name>
--      already applied" when this migration's own name is already in
--      public.schema_migrations. If the ledger table does not exist yet, the
--      block does nothing. The table check is a nested IF on purpose: PL/pgSQL
--      fails when a condition like `to_regclass(..) IS NOT NULL AND EXISTS
--      (SELECT .. FROM schema_migrations)` references a missing table.
--   2. The last statement inserts this migration's name into schema_migrations.
--   3. Each migration has a matching .down.sql, and no psql meta-commands.
--
-- The name in the guard and in the final INSERT must match the file name
-- without the .sql suffix.

DO $$
BEGIN
    IF to_regclass('public.schema_migrations') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.schema_migrations
                    WHERE name = '2026-11_00_migration_ledger') THEN
            RAISE EXCEPTION 'migration 2026-11_00_migration_ledger already applied';
        END IF;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Record the migration that predates the ledger, and this one.
INSERT INTO public.schema_migrations (name)
VALUES ('2026-10_body_measurements'), ('2026-11_00_migration_ledger')
ON CONFLICT DO NOTHING;
