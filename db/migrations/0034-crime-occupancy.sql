-- #389: observed OC occupancy.
--
-- Torn tells us when a member JOINED a crime and who is in it right now. It
-- never tells us when someone LEFT. Every "left at" in the system today is
-- inferred from crime status, execution time and the absence of a slot row —
-- four passes at that inference (#168, #262, #389, #392) each found a real
-- defect and the count stayed wrong.
--
-- This table records what was actually observed instead: a minute-by-minute
-- poll of the current crimes, one row per contiguous stint.
--
-- SURROGATE KEY, deliberately. crime_participation_v2 is unique on
-- (crime_id, member_id), so a member who leaves a crime and rejoins it has
-- their first stint overwritten and silently lost. Multiple stints per member
-- per crime is the entire point of this table.
CREATE TABLE IF NOT EXISTS public.crime_occupancy (
  id             bigserial PRIMARY KEY,
  crime_id       text   NOT NULL,
  member_id      text   NOT NULL,
  -- Which slot. A move between positions inside one crime is a real event and
  -- ends the stint, because the member did leave the slot they were in.
  position_id    text,
  -- Torn's own joined_at. Exact when present, so it wins as the stint START;
  -- first_seen_at is the fallback and, more usefully, the cross-check.
  torn_joined_at bigint,
  -- Our observations. first_seen_at is when the poller first saw them in this
  -- slot; last_seen_at is the most recent poll that still saw them there.
  first_seen_at  bigint NOT NULL,
  last_seen_at   bigint NOT NULL,
  -- Closed = we observed them ABSENT from a crime that was present in the
  -- response. Never set from a crime simply missing from the page: that is
  -- "we did not look", not "they left" (the #330 mistake).
  closed         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One open stint per (crime, member, slot) is the invariant the poller relies
-- on to decide insert-vs-extend. Partial unique index, so closed history is
-- unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS crime_occupancy_open_uniq
  ON public.crime_occupancy (crime_id, member_id, COALESCE(position_id, ''))
  WHERE NOT closed;

-- The payout query: a member's stints overlapping a window.
CREATE INDEX IF NOT EXISTS crime_occupancy_member_window_idx
  ON public.crime_occupancy (member_id, first_seen_at, last_seen_at);

CREATE INDEX IF NOT EXISTS crime_occupancy_crime_idx
  ON public.crime_occupancy (crime_id);

-- #389: poll heartbeat.
--
-- If the poller stops, everyone still present resumes correctly on restart,
-- but anyone who LEFT during the outage keeps accruing to the resume time. The
-- over-count is bounded by the gap, which is acceptable — as long as the
-- payout page can say the window has a hole in it. An unmarked hole is how a
-- wrong number gets paid.
CREATE TABLE IF NOT EXISTS public.crime_occupancy_polls (
  polled_at    bigint PRIMARY KEY,   -- epoch seconds
  crimes_seen  integer NOT NULL DEFAULT 0,
  slots_seen   integer NOT NULL DEFAULT 0,
  opened       integer NOT NULL DEFAULT 0,
  closed       integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crime_occupancy_polls_at_idx
  ON public.crime_occupancy_polls (polled_at DESC);
