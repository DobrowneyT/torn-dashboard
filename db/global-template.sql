-- The `global` database: Torn-wide facts that are identical for every faction.
--
-- ⚠️ Why this exists at all, from the #608 audit. The organizing question is
-- NOT "is this data Torn-global" but "can ONE API key fetch it". Every
-- faction-scoped endpoint needs that faction's own pooled keys, so members,
-- crimes, wars, attacks and revives can never live here no matter how much
-- duplication they cause. Checked against every scraper job's real endpoint,
-- exactly two of twenty qualify: the OC scenario model (needs no Torn key at
-- all) and the item catalogue (public /v2/torn/items, any key will do).
--
-- ⚠️ Direction of trust. Tenants READ this database directly; the admin
-- container is the only WRITER and is not in a tenant's read path. That is what
-- makes #609's hardest constraint -- "killing the admin container leaves every
-- tenant fully functional" -- true by construction rather than by careful
-- engineering. Two roles enforce it: app_global_ro (tenants, SELECT only) and
-- app_global_rw (the admin container).
--
-- ⚠️ This file is the source of truth for a NEW global database, exactly as
-- db/template.sql is for a new faction. db/migrations-global/*.sql brings an
-- EXISTING one up to the same shape. Both must be kept in step: a table added
-- to one and not the other is a database that behaves differently depending on
-- when it was created, which is the bug this convention exists to prevent.

-- Fleet metadata: one row, so a tenant can report what it is reading and the
-- control plane can report what it last wrote.
--
-- ⚠️ Singleton by constraint, not by convention. `CHECK (id = 1)` makes a
-- second row impossible rather than merely unusual -- two rows here would mean
-- two answers to "which model version is the fleet on", and whichever one a
-- query happened to return would look authoritative.
CREATE TABLE IF NOT EXISTS fleet_meta (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Bumped by each migration in db/migrations-global. A tenant surfaces this
  -- on /api/health/ready so a fleet view can spot a tenant reading a database
  -- that is behind, which is otherwise invisible.
  schema_version integer NOT NULL DEFAULT 0,
  -- Set by the admin container when it publishes a build (#606). NULL means no
  -- model has been published yet -- deliberately distinct from version 0.
  oc_model_version text,
  oc_model_built_at timestamptz,
  -- When the item catalogue was last refreshed. NULL until items-sync moves
  -- here. ⚠️ Tenants must treat a stale or NULL value as "prices unavailable"
  -- and fall back to their own key pool, never as "prices are current" -- one
  -- key feeding the whole fleet is a single point of failure whose failure mode
  -- is silent (see #123/#124 for how long that goes unnoticed).
  items_synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO fleet_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Fleet alerting (#609 slice 4) ───────────────────────────────────────────
--
-- ⚠️ Incident state is PERSISTED rather than held in the admin container's
-- memory, because an in-memory map is empty after every restart — so a redeploy
-- would re-announce every open incident, turning "one incident, one message"
-- into "one message per deploy". See server/src/adminPlane/incidents.ts.
--
-- ⚠️ These three tables are control-plane-private: db/grants.mjs revokes SELECT
-- on them from app_global_ro. No tenant reads them, and they carry a fleet-wide
-- view (which factions exist, which are down) that a single compromised tenant
-- container has no business holding.

-- Current state, one row per alert key. Rows are DELETEd when an incident
-- clears; the history lives in alert_events.
CREATE TABLE IF NOT EXISTS alert_incidents (
  key           text PRIMARY KEY,
  severity      text NOT NULL,
  title         text NOT NULL,
  detail        text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  observations  integer NOT NULL DEFAULT 1,
  misses        integer NOT NULL DEFAULT 0,
  -- NULL means "seen but not yet confirmed" -- distinct from "confirmed at some
  -- time". A blip below the confirm threshold produces no message either way.
  opened_at     timestamptz
);

-- Append-only history; the daily digest is a query over this, which is what
-- reports incidents that opened AND closed overnight.
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

-- The control plane's own bookkeeping (last digest sent, and whatever later
-- slices need). Generic and tiny on purpose: a table per scalar is worse.
CREATE TABLE IF NOT EXISTS control_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Fleet feature-flag defaults (#609 slice 5) ──────────────────────────────
--
-- Global default, tenant override wins. ⚠️ Unlike the alerting tables above,
-- these rows ARE for tenants to read — that is the whole point — so
-- app_global_ro keeps its SELECT.
--
-- ⚠️ The row's EXISTENCE is the "set" signal, and the CHECK is what makes that
-- unambiguous: `'null'::jsonb` is NOT SQL NULL, so a plain NOT NULL column
-- would store a JSON null happily and leave "set to nothing" indistinguishable
-- from "unset" — the exact distinction this table exists to preserve. Unset a
-- flag by DELETEing the row, never by writing null.
CREATE TABLE IF NOT EXISTS fleet_flags (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL CHECK (jsonb_typeof(value) <> 'null'),
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Faction provisioning requests (#609 slice 6) ────────────────────────────
--
-- ⚠️ This table IS the security boundary. The admin container cannot provision
-- a faction itself — that needs Postgres superuser, write access to the deploy
-- directory, and Docker, on the one container that accepts logins from the
-- internet. It writes a REQUEST here instead, and a host-side agent outside
-- every container claims it and runs ONE known command with these validated
-- arguments. A fully compromised admin container can therefore only ask for a
-- faction to be created; it cannot run arbitrary docker or shell. That bound
-- disappears the moment the Docker socket is mounted instead.
--
-- ⚠️ Control-plane-private: db/grants.mjs revokes SELECT from app_global_ro. It
-- names factions that do not exist yet and carries operator identity.
CREATE TABLE IF NOT EXISTS provision_requests (
  id               bigserial PRIMARY KEY,
  slug             text NOT NULL,
  display_name     text NOT NULL,
  torn_faction_id  text NOT NULL,
  leader_id        text,
  admin_id         text,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'done', 'failed')),
  -- ⚠️ Provisioning is multi-step and partially completes, so "failed" alone is
  -- not enough to act on: the operator needs to know whether the database
  -- exists yet, which decides whether a retry adopts or creates.
  step             text,
  log              text NOT NULL DEFAULT '',
  requested_by     text,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  attempts         integer NOT NULL DEFAULT 0
);

-- ⚠️ At most one live request per slug. Two runs of new-faction.mjs for the
-- same slug at once is how you get a role that exists and a schema that does
-- not.
CREATE UNIQUE INDEX IF NOT EXISTS provision_requests_live_slug
  ON provision_requests (slug) WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS provision_requests_requested_at_idx
  ON provision_requests (requested_at DESC);

-- ── The fleet item catalogue (#609 slice 7) ─────────────────────────────────
--
-- One of exactly TWO jobs the #608 audit found movable: /v2/torn/items is
-- public, so one key serves the whole fleet where every faction-scoped job
-- needs that faction's own pool.
--
-- ⚠️ This table is what the "silent single point of failure" warning is about.
-- Each tenant currently fetches from its own hourly re-verified pool (#309) and
-- survives any one key dying; fed by one key, prices quietly stop updating and
-- every faction keeps valuing payouts off a stale table -- the decay that ran
-- for months in July (#123/#124). Both mitigations live in the tenant and are
-- required together: it adopts these rows only while fleet_meta.items_synced_at
-- is fresh, and otherwise falls back to its own key pool.
--
-- ⚠️ Tenants MUST read this, unlike the alerting and provisioning tables, so
-- app_global_ro keeps its SELECT. Columns mirror the tenant `items` table
-- exactly so adopting the fleet copy is a straight upsert.
CREATE TABLE IF NOT EXISTS items (
  id           integer PRIMARY KEY,
  name         text NOT NULL,
  description  text,
  effect       text,
  type         text,
  sub_type     text,
  market_price bigint,
  sell_price   bigint,
  buy_price    bigint,
  circulation  integer,
  is_tradable  boolean DEFAULT true,
  image_url    text,
  last_updated timestamptz NOT NULL DEFAULT now()
);
