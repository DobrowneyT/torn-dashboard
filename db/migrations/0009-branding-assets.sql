-- #173: uploaded branding images (logo / favicon / hero) stored in the tenant
-- DB as bytea — small and few, so this rides the existing per-faction backups
-- and isolation for free (no shared volume / object store to wire). One row per
-- kind; branding.<kind> in faction_config points at /api/branding/<kind>.
CREATE TABLE IF NOT EXISTS public.faction_branding_assets (
  kind         text PRIMARY KEY,
  content_type text NOT NULL,
  bytes        bytea NOT NULL,
  updated_at   timestamp with time zone NOT NULL DEFAULT now()
);
