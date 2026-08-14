-- #395: faction calendar.
--
-- Two tables, and the split between them is the whole design.
--
-- Almost everything the calendar shows is DERIVED — ranked wars, competitions,
-- payout weeks, expiring OCs all live in their own tables and the calendar is a
-- view onto them. Nothing here duplicates those. What this migration adds is
-- only the things with no other home:
--
--   1. `calendar_events` — typed-in entries. Roll calls, chain attempts, and
--      (slice 4, folded in from #424) Torn's own events, which have NO API:
--      the entire v2 spec exposes `/user/calendar` (the caller's preferred
--      start hour) and `/user/competition` (a competition already running).
--      Neither can tell us an event is COMING, so Christmas Town gets typed in.
--
--   2. `member_birthdays` — real-world birthdays, which Torn does not hold at
--      all. The Torn-account anniversary is a separate thing and is NOT stored
--      here: it is derived from the profile blob we already snapshot daily.
CREATE TABLE IF NOT EXISTS public.calendar_events (
  id         bigserial PRIMARY KEY,
  -- 'manual' (roll calls, chain nights) or 'torn_event' (Christmas Town, the
  -- annual competitions). Same table because the distinction that matters to
  -- the reader is "someone typed this in" vs "the system knows it", and both
  -- of these are typed in. The badge differs; the trust level does not.
  source     text NOT NULL DEFAULT 'manual'
             CHECK (source IN ('manual', 'torn_event')),
  title      text NOT NULL,
  note       text,
  starts_at  timestamptz NOT NULL,
  -- NULL means a point in time, not a zero-length event. The UI must not
  -- render an end for these.
  ends_at    timestamptz,
  -- ⚠️ Yearly recurrence exists because this table carries the one part of the
  -- calendar with no automatic source behind it, and the ticket's own warning
  -- is that a hand-maintained calendar is stale within a fortnight. "Christmas
  -- Town, every December" survives that; a row someone must remember to re-add
  -- does not.
  recurrence text NOT NULL DEFAULT 'none'
             CHECK (recurrence IN ('none', 'yearly')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_events_starts_idx
  ON public.calendar_events (starts_at);

-- Real-world birthdays. Torn has no DOB field anywhere in its API, so this is
-- the only way to hold one — and holding one is a privacy decision, not just a
-- schema decision:
--
--   • Month and day are what a faction actually uses. The YEAR is optional and
--     separate, because "when do we say happy birthday" needs neither someone's
--     age nor a full date of birth, and asking for data you will not use is how
--     you end up holding data you should not have.
--   • One row per member, deletable. Withdrawal has to actually delete.
CREATE TABLE IF NOT EXISTS public.member_birthdays (
  member_id   text PRIMARY KEY,
  birth_month integer NOT NULL CHECK (birth_month BETWEEN 1 AND 12),
  birth_day   integer NOT NULL CHECK (birth_day BETWEEN 1 AND 31),
  birth_year  integer CHECK (birth_year BETWEEN 1900 AND 2100),
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
