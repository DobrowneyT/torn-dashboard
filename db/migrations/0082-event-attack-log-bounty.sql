-- Bounties claimed, read from the archived attack logs (parser v3).
--
-- ⚠️ A bounty is only ever claimed on a HOSPITALIZE, and Torn writes it on that
-- line: "X hospitalized Y and claimed a $100,000 bounty (+3.13)" — the only
-- wording in ~2,100 forge logs (2026-10-17). Null when the attack claimed none.
ALTER TABLE public.event_attack_log_parsed ADD COLUMN IF NOT EXISTS bounty_amount bigint;
