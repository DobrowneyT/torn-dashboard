-- #336: live energy + drug/medical/booster cooldowns for OUR OWN members.
--
-- Two pieces:
--
--   1. A poll cadence on the war-room config. 0 disables the poller entirely;
--      any other value is floored at 30s (see CONFIG_BOUNDS in
--      warRoomConfigBounds.ts — the range is deliberately non-contiguous).
--      Default 0: this costs one Torn call per enrolled member per cycle, so it
--      stays off until leadership turns it on.
--
--   2. A table for the results, SEPARATE from war_room_state_v2 rather than
--      extra columns on it. That separation is the access gate: state rows are
--      broadcast to every connected socket, whereas this data (when a teammate
--      is playing, whether they are mid-overdose) goes to war leads only. Its
--      own table means its own delta channel, which the hub can withhold.
--
-- Cooldowns are Torn's raw SECONDS-REMAINING at fetch time, not timestamps, so
-- fetched_at is required to age them into a live countdown client-side.

ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS member_stats_poll_interval_sec integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS public.war_room_member_stats_v2 (
  member_id      bigint PRIMARY KEY,
  energy_current integer,
  energy_maximum integer,
  cooldown_drug    integer,
  cooldown_medical integer,
  cooldown_booster integer,
  -- Null until the member's first successful fetch; set when their own key
  -- fails so the UI can distinguish "no data yet" from "we tried and couldn't".
  last_error     text,
  fetched_at     timestamp with time zone,
  updated_at     timestamp with time zone DEFAULT now() NOT NULL
);

-- The delta protocol is watermark-based: clients ask for everything changed
-- since a server timestamp, so updated_at carries every incremental fetch.
CREATE INDEX IF NOT EXISTS war_room_member_stats_v2_updated_at_idx
  ON public.war_room_member_stats_v2 (updated_at);
