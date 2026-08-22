-- #523: attacker-set, live "raise a hand" markers — smoke/tear/help, one click
-- from the attack page against (requester, target). Deliberately NOT the same
-- table as war_room_dibs_v2: dibs claims a target for a kill; this asks
-- teammates for help mid-fight, and the two can coexist on the same target.
-- `source` is a discriminator seat for CAT's lead-set-in-advance markers
-- (explicitly out of scope for #523) so that feature can land later without a
-- migration that rewrites these rows — default 'live' is the only source built.
CREATE TABLE IF NOT EXISTS public.war_room_assists_v2 (
  id bigserial PRIMARY KEY,
  target_id bigint NOT NULL,
  requester_id bigint NOT NULL,
  requester_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('smoke', 'tear', 'help')),
  source text NOT NULL DEFAULT 'live',
  war_id bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  -- Short-timeout backstop (reuses the war_room_dibs_v2 auto_expire_at sweep
  -- pattern, see warRoomAssistsExpiry.ts): armed at creation, always — an
  -- assist request means "I am in this fight right now", not "eventually".
  auto_expire_at timestamp with time zone,
  deleted_at timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS war_room_assists_v2_updated_at_idx ON public.war_room_assists_v2 (updated_at);
-- One live assist request per requester (mirrors dibs' one-live-claim rule) —
-- a fresh click replaces whatever the requester last asked for.
CREATE UNIQUE INDEX IF NOT EXISTS war_room_assists_v2_active_requester_idx
  ON public.war_room_assists_v2 (requester_id) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS war_room_assists_v2_active_target_idx
  ON public.war_room_assists_v2 (target_id) WHERE (deleted_at IS NULL);
