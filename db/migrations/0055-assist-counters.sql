-- #591: assist requests carry a COUNT, and are decremented by observed actions.
--
-- `wanted` is how many of a thing the requester is still asking for. Pressing
-- the same button again on the same target raises it; a verified in-faction
-- smoke/tear/join lowers it; at zero the request is tombstoned. Stacked smoke
-- grenades are a real use case, so this is not help-only.
ALTER TABLE public.war_room_assists_v2
  ADD COLUMN IF NOT EXISTS wanted integer NOT NULL DEFAULT 1;

-- Observations that have already been counted.
--
-- ⚠️ This table exists ONLY to deduplicate. Every member with the userscript
-- open sees the SAME fight log, so one join arrives once per observer, and
-- without a natural key the counter would drain as fast as people are watching.
-- Torn gives no stable fight id, so the key is the event itself: who did what,
-- to whom, in which second.
--
-- `event_second` is unix seconds, derived client-side from the log's relative
-- age ("69s") against the observer's clock. Second-resolution is deliberate —
-- two observers' clocks will not agree to the millisecond, and rounding to the
-- second is what makes their reports collide instead of both counting.
CREATE TABLE IF NOT EXISTS public.war_room_assist_observations_v2 (
  id bigserial PRIMARY KEY,
  target_id bigint NOT NULL,
  actor_id bigint NOT NULL,
  actor_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('smoke', 'tear', 'join')),
  event_second bigint NOT NULL,
  reported_by bigint NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS war_room_assist_observations_v2_event_idx
  ON public.war_room_assist_observations_v2 (target_id, actor_id, kind, event_second);

-- Pruned by age, not tombstoned: this is a dedupe ledger, not history anyone
-- reads back.
CREATE INDEX IF NOT EXISTS war_room_assist_observations_v2_created_idx
  ON public.war_room_assist_observations_v2 (created_at);
