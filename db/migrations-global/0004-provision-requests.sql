-- #609 slice 6: provisioning a faction from the admin console.
--
-- ⚠️ This table IS the security boundary, and it is worth being explicit about
-- why it exists at all. The admin container cannot provision a faction itself:
-- doing so needs Postgres superuser, write access to the deploy directory, and
-- Docker — on the one container that accepts logins from the internet. So it
-- writes a REQUEST here, and a host-side agent outside every container claims
-- it and runs one known command with these validated arguments.
--
-- A fully compromised admin container therefore cannot run arbitrary docker or
-- shell. It can only ask for a faction to be created. That bound is the entire
-- point, and it disappears the moment the Docker socket is mounted instead.
CREATE TABLE IF NOT EXISTS provision_requests (
  id               bigserial PRIMARY KEY,
  slug             text NOT NULL,
  display_name     text NOT NULL,
  torn_faction_id  text NOT NULL,
  -- First role assignments (#99). Optional: a faction can be provisioned and
  -- have its leader granted afterwards.
  leader_id        text,
  admin_id         text,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'done', 'failed')),
  -- Which step it reached. ⚠️ Provisioning is multi-step and partially
  -- completes, so "failed" alone is not enough to act on — the operator needs
  -- to know whether the database exists yet.
  step             text,
  log              text NOT NULL DEFAULT '',
  requested_by     text,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  attempts         integer NOT NULL DEFAULT 0
);

-- ⚠️ At most one live request per slug. Two agents — or one agent and an
-- impatient operator clicking twice — running new-faction.mjs for the same slug
-- concurrently is how you get a half-created database with a role that exists
-- and a schema that does not.
CREATE UNIQUE INDEX IF NOT EXISTS provision_requests_live_slug
  ON provision_requests (slug) WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS provision_requests_requested_at_idx
  ON provision_requests (requested_at DESC);

-- ⚠️ Control-plane-private, like the alerting tables: it names factions that do
-- not exist yet and carries operator identity. Guarded on the role existing,
-- because migrations also run against databases provisioned before it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_global_ro') THEN
    REVOKE ALL ON provision_requests FROM app_global_ro;
  END IF;
END $$;

UPDATE fleet_meta SET schema_version = GREATEST(schema_version, 4), updated_at = now() WHERE id = 1;
