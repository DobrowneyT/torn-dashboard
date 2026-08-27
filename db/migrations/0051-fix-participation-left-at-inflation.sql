-- crimeParticipation.ts closed a departed member's segment using
-- crime.executed_at ?? crime.expired_at ?? null UNCONDITIONALLY, even when
-- the crime was still Recruiting/Planning (unresolved). expired_at is the
-- crime's future deadline, stamped from creation, not evidence anything had
-- actually happened — so a member who left a still-open crime got left_at
-- set to a date that hadn't occurred yet, sometimes days past the payout
-- window it was later read into. bankedTimeByMember (frontend) clips
-- [joined_at, left_at] to the payout window, so this inflated "counted"
-- time spent for anyone whose left-early stint got mis-closed this way —
-- diagnosed by cross-referencing against the #389 occupancy poller's
-- observed data, which had no such error.
--
-- Detection: left_at set to a timestamp AFTER the row was last written is
-- impossible for a real observation (you cannot be recorded as leaving
-- after we already wrote the record) — this can only be the future-expiry
-- bug, and cannot false-positive on a genuinely resolved crime (Torn only
-- reports execution after it has already happened). Corrected to
-- updated_at, which already holds the real "when we detected this" time —
-- the scraper just wrote the wrong value into the wrong column.
UPDATE public.crime_participation_v2
   SET left_at = extract(epoch FROM updated_at)::bigint
 WHERE completed = false
   AND left_at IS NOT NULL
   AND left_at > extract(epoch FROM updated_at)::bigint;
