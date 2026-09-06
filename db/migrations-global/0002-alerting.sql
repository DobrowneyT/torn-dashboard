-- #609 slice 4: incident state for fleet alerting.
--
-- ⚠️ This state is PERSISTED rather than held in the admin container's memory,
-- and the reason is the most routine operation in the stack. An in-memory map
-- is empty after every restart, so a redeploy would re-announce every currently
-- open incident — turning "one incident, one message" into "one message per
-- deploy", triggered by the very thing an operator does while fixing it.
--
-- Idempotent, like every migration here: re-running must be free.

-- Current state, one row per alert key. Rows are DELETEd when an incident
-- clears; the history lives in alert_events.
CREATE TABLE IF NOT EXISTS alert_incidents (
  key           text PRIMARY KEY,
  severity      text NOT NULL,
  title         text NOT NULL,
  detail        text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  -- Cycles observed, and consecutive cycles missed. Together these are the
  -- flap suppression; see server/src/adminPlane/incidents.ts for why both.
  observations  integer NOT NULL DEFAULT 1,
  misses        integer NOT NULL DEFAULT 0,
  -- NULL means "seen but not yet confirmed", which is deliberately distinct
  -- from "confirmed at some time". A blip that never reached the confirm
  -- threshold must produce no message at all, in either direction.
  opened_at     timestamptz
);

-- Append-only history. The daily digest is a query over this, which is what
-- keeps the digest honest about incidents that opened AND closed overnight —
-- exactly the ones nobody was awake to see.
CREATE TABLE IF NOT EXISTS alert_events (
  id       bigserial PRIMARY KEY,
  key      text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('opened', 'resolved')),
  severity text NOT NULL,
  title    text NOT NULL,
  detail   text NOT NULL DEFAULT '',
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_events_at_idx ON alert_events (at DESC);

-- Small key/value scratchpad for the control plane's own bookkeeping — when
-- the last digest went out, and whatever slice 5 onward needs. Deliberately
-- generic and deliberately tiny: a table per scalar is worse.
CREATE TABLE IF NOT EXISTS control_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ⚠️ GREATEST, not a bare assignment — migrations re-run on every deploy, and a
-- plain SET would walk the version backwards past any later migration.
UPDATE fleet_meta SET schema_version = GREATEST(schema_version, 2), updated_at = now() WHERE id = 1;

-- ⚠️ Control-plane-private. `ALTER DEFAULT PRIVILEGES` (db/grants.mjs) hands
-- app_global_ro SELECT on every table created afterwards, which is right for
-- shared fleet data and wrong for these three: no tenant reads them, and they
-- hold a fleet-wide view -- which factions exist, which are down right now --
-- that a single compromised tenant container has no business holding.
--
-- Guarded on the role existing because migrations also run against databases
-- provisioned before the role was introduced, and an unguarded REVOKE would
-- abort the whole migration with "role does not exist".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_global_ro') THEN
    REVOKE ALL ON alert_incidents, alert_events, control_state FROM app_global_ro;
  END IF;
END $$;
