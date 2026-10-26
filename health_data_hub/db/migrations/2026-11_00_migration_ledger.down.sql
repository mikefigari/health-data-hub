-- Down: removes the migration ledger. Drops only public.schema_migrations.
DROP TABLE IF EXISTS public.schema_migrations;
