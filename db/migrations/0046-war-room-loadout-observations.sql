-- #528 Part 2: enemy loadout observations captured from the attack page once
-- Torn reveals them (weapons/armor are hidden until the fight actually
-- starts — see frontend/userscripts/tnl-war-room-dibs.user.js).
--
-- Deliberately its OWN table, not war_room_state_v2 (per #528's own warning):
-- that table is the live per-member delta, overwritten every roster tick and
-- broadcast to every client. A loadout observation is a point-in-time,
-- provenanced fact about a specific PLAYER — append-only, never overwritten,
-- so the history survives even as the "current" picture changes. The War
-- Room reads the latest row per target_id (see warRoom.ts's 'loadout'
-- channel); nothing here is ever UPDATEd or soft-deleted — retention is a
-- hard prune (server/src/warRoomLoadout.ts, wired unconditionally in
-- main.ts) rather than a tombstone, because there is no "undo" for this kind
-- of record and no client needs to see a cancellation frame for it.
CREATE TABLE IF NOT EXISTS public.war_room_loadout_observations_v2 (
  id bigserial PRIMARY KEY,
  target_id bigint NOT NULL,
  observed_by bigint NOT NULL,
  observed_by_name text NOT NULL,
  war_id bigint,
  -- { weapons: { primary|secondary|melee|temporary: { name, item_id? } },
  --   armor:   { helmet|chest|pants|boots|gloves: { name, item_id? } } }
  -- `name` is the trusted signal (from aria-label / <area title>, neither of
  -- which a gear-hiding userscript can touch — see #528's own DOM research);
  -- `item_id` is a best-effort, NEVER-required bonus parsed from an <img src>
  -- that may or may not survive. Shape enforced server-side, not by the DB —
  -- see validateLoadoutPayload in warRoomLoadout.ts.
  loadout jsonb NOT NULL,
  observed_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- "Latest observation per target" is the War Room's whole read pattern.
CREATE INDEX IF NOT EXISTS war_room_loadout_observations_v2_target_idx
  ON public.war_room_loadout_observations_v2 (target_id, observed_at DESC);
-- Per-member rate limiting reads a member's recent rows; the daily prune scans
-- by age across the whole table.
CREATE INDEX IF NOT EXISTS war_room_loadout_observations_v2_observed_by_idx
  ON public.war_room_loadout_observations_v2 (observed_by, created_at);
CREATE INDEX IF NOT EXISTS war_room_loadout_observations_v2_observed_at_idx
  ON public.war_room_loadout_observations_v2 (observed_at);
