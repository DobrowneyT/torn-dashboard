-- #284 Membership tenure: lifetime total-days (from Torn's roster days_in_faction)
-- and an observed-presence stint history (for the current streak). Idempotent —
-- safe to re-run against an existing DB.

-- Lifetime total days in faction, captured from the roster on each members-sync.
ALTER TABLE members ADD COLUMN IF NOT EXISTS total_days_in_faction integer;

-- One row per observed continuous-membership stint. left_at IS NULL = the open
-- (current) stint; streak = now - joined_at of the open stint.
CREATE TABLE IF NOT EXISTS public.member_faction_stints (
  id        bigserial PRIMARY KEY,
  member_id text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz
);

-- At most one open stint per member (also the ON CONFLICT target on open).
CREATE UNIQUE INDEX IF NOT EXISTS member_faction_stints_one_open_idx
  ON public.member_faction_stints (member_id) WHERE left_at IS NULL;
-- Per-member history lookups (streak + audit).
CREATE INDEX IF NOT EXISTS member_faction_stints_member_idx
  ON public.member_faction_stints (member_id, joined_at);
