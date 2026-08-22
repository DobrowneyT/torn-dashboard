-- Capture every field Torn's faction/attacks v2 endpoint returns (#543).
-- Audited against the live OpenAPI spec and a live faction 10739 call:
-- attacksSync.ts wrote 20 columns and silently discarded 11 fields Torn was
-- already sending on every row at no extra API cost.
--
-- Existing rows are left as-is: the 13 new columns are simply null on
-- anything scraped before this migration. A one-time backfill (truncate +
-- re-walk the full available window) is an operator action run by hand
-- after this deploys, not part of the migration — db/migrate.mjs has no
-- ledger and replays every file on every deploy, so a TRUNCATE baked in
-- here would fire again on the next deploy, and the one after that.
ALTER TABLE public.faction_attacks
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS attacker_level integer,
  ADD COLUMN IF NOT EXISTS defender_level integer,
  ADD COLUMN IF NOT EXISTS respect_loss numeric(10,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_interrupted boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_stealthed boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_raid boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_territory_war boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS territory_war_id integer,
  ADD COLUMN IF NOT EXISTS finishing_hit_effects jsonb,
  ADD COLUMN IF NOT EXISTS retaliation_modifier numeric(6,4) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS group_modifier numeric(6,4) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS overseas_modifier numeric(6,4) DEFAULT 1;
