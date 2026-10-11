-- #945 — one row per war's wrap-up, so a failed one can be re-run and a
-- succeeded one is never queued twice.
--
-- ⚠️ Separate from `ranked_wars` on purpose. `is_termed` and the scores there
-- are facts about the war; this is the state of OUR processing of it, and
-- mixing the two means a schema where "did we finish collecting" lives next to
-- "who won" and a careless UPDATE touches both.
CREATE TABLE IF NOT EXISTS public.war_wrap_up_state (
  war_id bigint PRIMARY KEY,

  -- waiting → sources are not all present yet, inside the retry window.
  -- failed  → gave up, loudly. Nothing was queued. A human has to look.
  -- queued  → every source confirmed and the roster is in the outbox. Terminal.
  --
  -- ⚠️ `queued` is what makes a re-run safe: the job skips a war that reached
  -- it, so re-running after a failure cannot double-queue a war that had
  -- already succeeded.
  state text NOT NULL DEFAULT 'waiting'
    CHECK (state IN ('waiting', 'failed', 'queued')),

  -- ⚠️ When we FIRST saw this war ended, not when we last tried. The retry
  -- window is measured from here, so a restart does not reset the clock and a
  -- war cannot sit in `waiting` for ever by being retried often enough.
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,

  -- Why it is waiting or why it failed, in words, for whoever is looking.
  last_error text,

  -- How many members went into the mailbox, for the run log.
  queued_members integer,
  completed_at timestamptz
);

-- The job's own lookup: wars still in flight, oldest first.
CREATE INDEX IF NOT EXISTS war_wrap_up_state_pending_idx
  ON public.war_wrap_up_state (first_seen_at)
  WHERE state = 'waiting';
