-- #771: Chain Watch — the hourly sign-up sheet and its payout record.
--
-- Replaces a Google Sheet that worked. Three things it could not do are the
-- reason these columns look the way they do:
--
--   1. It matched watchers by DISPLAY NAME (`COUNTIF` over the grid). Names
--      move — the workbook's own roster tab now reads `Muttley_616` where its
--      frozen 2025 grid says `Muttley` — and a rename returned 0 with no
--      error. Sign-ups here key on the Torn player ID; the name is resolved
--      for display at read time.
--
--   2. Its bonus was pinned to spreadsheet COLUMNS H:I, which are 05:00-07:00
--      TCT on a midnight block and 17:00-19:00 on a noon block. 59 slots were
--      paid the bonus; only 31 sat in a cell the legend coloured. Bonus hours
--      here are hours-of-day on the event and are DERIVED at read time, so a
--      correction applies to hours already served.
--
--   3. Its window was generated once, for 25 Oct 10:00 → 1 Nov 16:00 TCT, and
--      the chain outran it — the real sheet carries sign-ups through 3 Nov,
--      extended by hand. The window here grows a day at a time.

CREATE TABLE IF NOT EXISTS public.chain_events (
  id                bigserial PRIMARY KEY,
  title             text NOT NULL,

  -- ⚠️ The PLANNED window. An event does NOT start at midnight: the 2025 one
  -- ran 10:00 TCT to 16:00 TCT, partial days at both ends. Grouping by TCT day
  -- is a reading convenience; the window is an arbitrary hour to an arbitrary
  -- hour, and "add a day" is +24h preserving that offset.
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,

  -- ⚠️ What actually happened, as against the plan above. The grid is built
  -- out past the expected end deliberately, because nobody knows how long a
  -- 100k chain runs — it depends on how many people are hitting. An hour after
  -- the chain really ended is not a shift served and is not paid, but it stays
  -- VISIBLE, or the member cannot see why. Payout reads
  -- COALESCE(actually_ended_at, ends_at); the grid reads ends_at.
  actually_ended_at timestamptz,

  -- Two watchers per hour is a choice, not a law. A 100k attempt may want three.
  slots_per_hour    integer NOT NULL DEFAULT 2 CHECK (slots_per_hour BETWEEN 1 AND 6),

  -- Last run paid 1.5m per slot. Last run's rate is not next run's rate.
  payout_per_slot   bigint NOT NULL DEFAULT 1500000 CHECK (payout_per_slot >= 0),

  -- TCT hours-of-day that earn the bonus. Default {5,6} is the 2025 sheet's
  -- INTENT — the graveyard hours — not the 17:00-19:00 its formula actually
  -- paid. Leadership edits this while the event runs.
  bonus_hours       integer[] NOT NULL DEFAULT '{5,6}',
  bonus_multiplier  integer NOT NULL DEFAULT 2 CHECK (bonus_multiplier >= 1),
  bonus_applies_to  text NOT NULL DEFAULT 'tickets'
                    CHECK (bonus_applies_to IN ('tickets', 'payout', 'both')),

  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('draft', 'open', 'closed')),

  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chain_events_window CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS public.chain_watch_signups (
  id             bigserial PRIMARY KEY,
  event_id       bigint NOT NULL REFERENCES public.chain_events(id) ON DELETE CASCADE,
  hour_start     timestamptz NOT NULL,
  slot_index     integer NOT NULL CHECK (slot_index >= 0),

  -- ⚠️ The Torn player ID, never a name. See note 1 above.
  member_id      text NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text,

  -- ⚠️ Giving up a slot is a SOFT delete. A sign-up drives money, so deleting
  -- the row destroys the only evidence that someone held the hour: the member
  -- has nothing to point at and there is no record of who removed them.
  --
  -- `removed_by` is also what separates "I dropped it" from "I was dropped" —
  -- a member releasing their own slot records themselves, a leader taking
  -- someone out records the leader. Three weeks later at payout those must not
  -- read identically.
  removed_at     timestamptz,
  removed_by     text,
  removed_reason text
);

-- ⚠️ PARTIAL, and that is the whole point. A removal leaves the row behind, so
-- a plain unique index would let a dead row block the freed slot forever.
-- Scoping to live rows lets the slot be re-claimed while the history survives.
CREATE UNIQUE INDEX IF NOT EXISTS chain_watch_signups_slot_live
  ON public.chain_watch_signups (event_id, hour_start, slot_index)
  WHERE removed_at IS NULL;

-- ⚠️ One member cannot hold BOTH slots of an hour. Two watchers exist so that
-- one of them can fail; the same person twice is that redundancy quietly gone
-- while the grid still reads as covered. The 2025 sheet never did it — 0 of
-- 211 served hours — so this codifies practice rather than changing it.
--
-- A constraint rather than a handler check because the race is real: two tabs,
-- or a leader assigning at the moment the member claims.
--
-- Consecutive hours stay allowed, and must: `Sanityloss` worked four straight.
-- This is per hour, not per person per day.
CREATE UNIQUE INDEX IF NOT EXISTS chain_watch_signups_member_hour_live
  ON public.chain_watch_signups (event_id, hour_start, member_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS chain_watch_signups_event_hour
  ON public.chain_watch_signups (event_id, hour_start);

-- ── Sampling (#774 writes these; defined here so the schema lands in one place) ──
--
-- ⚠️ Append-only, and deliberately NOT war_room_chain_v2. That table is a
-- singleton (CHECK (id = 1)): every poll overwrites the last, so the chain's
-- end becomes a moment somebody had to catch rather than a fact that can be
-- read back — and a ranked war during the event would put two writers on one
-- row. Its poller also only runs during a war, and at one call every 5 seconds
-- would cost ~200k Torn calls over a twelve-day event.

CREATE TABLE IF NOT EXISTS public.chain_samples (
  id             bigserial PRIMARY KEY,
  sampled_at     timestamptz NOT NULL DEFAULT now(),
  chain_current  integer,
  -- Absolute epochs, converted on store exactly as warRoomChain.ts does:
  -- Torn sends these as RELATIVE seconds.
  chain_timeout  bigint,
  chain_cooldown bigint
);

CREATE INDEX IF NOT EXISTS chain_samples_sampled_at
  ON public.chain_samples (sampled_at DESC);

CREATE TABLE IF NOT EXISTS public.member_activity_samples (
  id                 bigserial PRIMARY KEY,
  sampled_at         timestamptz NOT NULL DEFAULT now(),
  member_id          text NOT NULL,
  last_action_epoch  bigint,
  status_state       text,
  status_description text,
  -- ⚠️ One roster call carries all of this: /v2/faction/members returns
  -- last_action AND the whole status object, which is where plane_image_type
  -- lives. There is no separate travel fetch to budget for.
  plane_image_type   text,
  travel_departed_at timestamptz
);

CREATE INDEX IF NOT EXISTS member_activity_samples_member_time
  ON public.member_activity_samples (member_id, sampled_at DESC);
