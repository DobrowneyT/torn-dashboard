-- #609 slice 1: the global database's first table.
-- Idempotent, like every migration here: re-running must be free.
CREATE TABLE IF NOT EXISTS fleet_meta (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  schema_version integer NOT NULL DEFAULT 0,
  oc_model_version text,
  oc_model_built_at timestamptz,
  items_synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO fleet_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ⚠️ GREATEST, not a bare assignment. Migrations run in filename order and are
-- re-run on every deploy, so a plain `SET schema_version = 1` would walk the
-- version BACKWARDS every time a later migration had already raised it.
UPDATE fleet_meta SET schema_version = GREATEST(schema_version, 1), updated_at = now() WHERE id = 1;
