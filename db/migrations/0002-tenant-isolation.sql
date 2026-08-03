-- Slice #75: cross-tenant isolation for databases created before the scoped
-- per-faction credentials. New DBs get this in db/new-faction.mjs; existing
-- DBs pick it up here. Idempotent: revoking an absent grant is a no-op.
-- The admin/superuser connection (snapshots, migrations) is unaffected, and
-- scoped app_<slug> roles hold an explicit CONNECT grant on their own DB.
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
END $$;
