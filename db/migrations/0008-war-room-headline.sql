-- #158: a leader-set headline banner for the War Room — one active message on
-- the config singleton, broadcast live over the existing 'config' channel.
-- tone drives the banner styling (danger/warn/go/neutral); set_by/at are for
-- the "set by X" footnote. Cleared on a new matchup by clearWarRoomState.
ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS headline_text   text,
  ADD COLUMN IF NOT EXISTS headline_tone   text,
  ADD COLUMN IF NOT EXISTS headline_set_by bigint,
  ADD COLUMN IF NOT EXISTS headline_set_at timestamp with time zone;
