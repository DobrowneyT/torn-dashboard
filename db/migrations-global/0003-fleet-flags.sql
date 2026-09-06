-- #609 slice 5: fleet-wide feature-flag defaults.
--
-- ⚠️ Unlike the alerting tables in 0002, these rows ARE for tenants to read —
-- that is their entire purpose. `app_global_ro` keeps the SELECT that
-- ALTER DEFAULT PRIVILEGES grants it.
--
-- ⚠️ The row's EXISTENCE is the "set" signal, and the CHECK below is what makes
-- that unambiguous. `'null'::jsonb` is not SQL NULL, so a NOT NULL column would
-- happily store a JSON null and leave "set to nothing" indistinguishable from
-- "unset" — which is precisely the distinction this whole table exists to keep.
-- To unset a flag, DELETE the row.
CREATE TABLE IF NOT EXISTS fleet_flags (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL CHECK (jsonb_typeof(value) <> 'null'),
  -- What this flag does, shown in the admin console. A flag nobody can explain
  -- six months later is a flag nobody dares change.
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

UPDATE fleet_meta SET schema_version = GREATEST(schema_version, 3), updated_at = now() WHERE id = 1;
