-- #773: a leader's decision on a flagged slot.
--
-- #774 records whether a watcher was absent, and whether the chain was at risk
-- while they were. It deliberately decides nothing: a flag is a row put in
-- front of a human (MonChoon, 2026-09-22 — "flag it, do not let the app
-- choose"). This is where the human's answer lands.
--
-- ⚠️ NULL means "not looked at yet", which is different from both 'paid' and
-- 'unpaid'. A flagged slot with no decision is still counted as payable — the
-- flag asks a question, it does not withhold money on its own.
ALTER TABLE public.chain_watch_signups
  ADD COLUMN IF NOT EXISTS pay_decision text
    CHECK (pay_decision IS NULL OR pay_decision IN ('paid', 'unpaid')),
  ADD COLUMN IF NOT EXISTS decided_by  text,
  ADD COLUMN IF NOT EXISTS decided_at  timestamptz;
