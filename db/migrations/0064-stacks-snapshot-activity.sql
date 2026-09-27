-- Who was actually AROUND when the war started (#480 follow-up, MonChoon 2026-09-27).
--
-- The snapshot recorded energy and the OD flag — whether somebody was STACKED —
-- but nothing about whether they were awake. A post-mortem asks three things:
-- what did they say they would do, were they ready, and did they show up. Only
-- the first two could be answered.
--
-- ⚠️ Nullable, and they must stay that way. Snapshots taken before this
-- migration cannot be backfilled: war_room_state_v2 is overwritten in place on
-- every sweep, so "what was their last action at 18:00 on the day of that war"
-- no longer exists anywhere. NULL here means NOT RECORDED, which is a different
-- statement from "never active", and the UI has to say so.
ALTER TABLE public.war_stacks_snapshot
  ADD COLUMN IF NOT EXISTS last_action_epoch bigint,
  ADD COLUMN IF NOT EXISTS status_state text;

COMMENT ON COLUMN public.war_stacks_snapshot.last_action_epoch IS
  'Torn last_action.timestamp (epoch seconds) as of captured_at. NULL = not recorded (pre-#480-follow-up snapshot, or no war-room reading for that member).';
COMMENT ON COLUMN public.war_stacks_snapshot.status_state IS
  'Torn status.state (Okay / Hospital / Traveling / Abroad / Jail) as of captured_at. NULL = not recorded.';
