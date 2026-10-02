-- Persist the ticket-qualifying time alongside each saved payout row.
--
-- ⚠️ Why this is needed, and it is not cosmetic: `ticketTimeSpent` is what
-- decides who draws an EQUAL share (#389 — a member whose only activity was a
-- left-early stint has no ticket time and must not take a full share while
-- that banked time is excluded from the money). It was computed in the browser
-- and thrown away on save. So a reopened equal week could not tell who the
-- participants were, and any recalculation on it — editing a single item
-- price is enough — had to fall back to `time_spent`, which answers a
-- different question and disagreed with the live sheet.
--
-- Nullable on purpose: rows written before this migration genuinely do not
-- have the value, and the reader falls back to `time_spent` for them, which is
-- exactly what those weeks were paid on. Backfilling a guess would rewrite
-- history that leaders have already handed money out against.
ALTER TABLE public.oc_payout_members
  ADD COLUMN IF NOT EXISTS ticket_time_spent bigint;
