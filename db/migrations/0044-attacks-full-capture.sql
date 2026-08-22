-- Capture every field Torn's faction/attacks v2 endpoint returns (#543).
-- Audited against the live OpenAPI spec and a live faction 10739 call:
-- attacksSync.ts wrote 20 columns and silently discarded 11 fields Torn was
-- already sending on every row at no extra API cost.
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

-- Backfill is bounded by Torn's own retention on this endpoint (~1 year,
-- confirmed live via sort=ASC), and every row already stored predates this
-- migration and would otherwise sit forever with 11 real columns and no way
-- to tell "Torn returned nothing" apart from "we weren't collecting it yet".
-- Wiping the table lets attacksSyncJob's own from=max(started) watermark
-- fall back to 0, so the very next run re-walks the full available window
-- and every row that comes back is complete from day one.
--
-- Nothing references faction_attacks by foreign key, and nothing downstream
-- keeps state derived from it beyond what a live query recomputes, so this
-- is safe to repeat on every tenant database this migration reaches.
TRUNCATE TABLE public.faction_attacks;
