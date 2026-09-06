-- #609 slice 7: the item catalogue, fetched once for the whole fleet.
--
-- One of exactly TWO jobs the #608 audit found movable, and the only one that
-- needs a Torn key: /v2/torn/items is public, so the admin container's single
-- key suffices where every faction-scoped job needs that faction's own pool.
-- One fetch instead of five is the rate-limit win.
--
-- ⚠️ This is the table the whole "silent single point of failure" warning is
-- about. Today each tenant fetches from its own hourly re-verified pool (#309)
-- and survives any one key dying. Fed by one key, prices quietly stop updating
-- and every faction keeps valuing payouts off a stale table — the same silent
-- decay that ran for months in July (#123/#124) before anyone noticed. Two
-- mitigations are REQUIRED, not either/or, and both live in the tenant:
-- it adopts these rows only while fleet_meta.items_synced_at is fresh, and
-- otherwise falls back to its own key pool.
--
-- ⚠️ Tenants MUST be able to read this — unlike the alerting and provisioning
-- tables, that is the entire point — so app_global_ro keeps the SELECT that
-- ALTER DEFAULT PRIVILEGES grants it.
--
-- Columns mirror the tenant `items` table exactly, so adopting the fleet copy
-- is a straight upsert rather than a mapping that can drift.
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

UPDATE fleet_meta SET schema_version = GREATEST(schema_version, 5), updated_at = now() WHERE id = 1;
