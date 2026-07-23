-- #168: retain per-(crime, member) participation stints so time a member
-- banked in a crime they LEFT before it executed isn't lost. crime_slots is
-- keyed by position and gets refilled when someone takes a vacated seat, so a
-- departed member can't be tracked there. The crimes-sync keeps one open
-- segment per current occupant and closes it (left_at) when they leave or the
-- crime resolves; `completed` marks a member who was present at execution.
CREATE TABLE IF NOT EXISTS public.crime_participation_v2 (
  crime_id   text NOT NULL,
  member_id  text NOT NULL,
  joined_at  bigint NOT NULL,
  left_at    bigint,
  completed  boolean NOT NULL DEFAULT false,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (crime_id, member_id)
);

CREATE INDEX IF NOT EXISTS crime_participation_v2_member_idx
  ON public.crime_participation_v2 (member_id);
