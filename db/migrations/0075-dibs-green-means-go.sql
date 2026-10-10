-- #935 — was the target GREEN (Okay and Online) while this claim was live?
--
-- A green target is outside the dibs system: they are at their keyboard and can
-- fly out or hospital themselves, so hitting them fast is encouraged and a
-- teammate who does has stolen nothing. #530's report calls that a steal today.
--
-- ⚠️ **Claim-time status alone cannot answer this**, which is the whole reason
-- there are two pairs of columns. The typical sequence is:
--
--   1. target in hospital, OFFLINE  → somebody claims them (a real reservation)
--   2. target logs in, STILL in hospital → claim untouched
--   3. target leaves hospital: Okay + Online → fair game
--   4. a teammate hits them
--
-- At claim time they were Hospital + Offline, so a claim-time-only design calls
-- step 4 a steal — exactly the dispute this is meant to settle.
--
-- ⚠️ Stored AS OBSERVED, never as a verdict. `claimKind()` in
-- server/src/warDibsGreen.ts does the interpreting, so a rule change does not
-- need a migration and does not rewrite history.
ALTER TABLE public.war_room_dibs_v2
  -- The target's condition when the claim was taken. Catches somebody claiming
  -- a target who was ALREADY green (MonChoon: "nobody should be claiming
  -- targets that are green" — but it happens).
  ADD COLUMN IF NOT EXISTS claim_state  text,
  ADD COLUMN IF NOT EXISTS claim_online text,
  -- ⚠️ The moment that actually matters: the target came OUT of hospital while
  -- this claim was live, and whether they were online when they did. Stamped by
  -- the dibs sweep, which already detects that transition to arm the #106
  -- countdown and observes it within about a second.
  --
  -- `surfaced_at` is the evidence half. MonChoon: "sometimes members claim 'my
  -- dibs was taken' … and we need to justify it that they were online so the
  -- dibs was no longer relevant" — a bucket cannot settle that argument, a
  -- timestamp can.
  ADD COLUMN IF NOT EXISTS surfaced_online boolean,
  ADD COLUMN IF NOT EXISTS surfaced_at     timestamptz;

-- The report's own bucket for them. ⚠️ Counted, never blamed: it is what
-- explains why a claim produced neither a conversion nor a failure, and it has
-- to exist as a column or the row stops adding up to `claims`.
ALTER TABLE public.war_dibs_summary
  ADD COLUMN IF NOT EXISTS green_means_go integer NOT NULL DEFAULT 0;
