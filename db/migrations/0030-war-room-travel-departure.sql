-- #330: estimated arrival time for travelling members.
--
-- Torn does NOT give an arrival time for travel: `status.until` is null for a
-- traveller (confirmed from live data), unlike hospital and jail which carry a
-- release timestamp. So the ETA has to be derived, and deriving it needs the
-- one thing the API never tells us — when they took off.
--
-- We poll the roster about once a second while the war room runs, so we OBSERVE
-- the transition into Traveling within roughly a poll interval. This column
-- latches that moment.
--
-- The staleness guard in the upsert is the important part. If the board was not
-- polling — war room disabled, roster cadence 0, process restarted — then the
-- first tick back sees a member who "just" became Traveling when in fact they
-- departed hours ago. Stamping now() there would produce a confidently wrong
-- arrival time, which is worse than none: a lead who waits on it wastes the
-- window. So a transition is only trusted when our previous look at that member
-- was recent; otherwise this stays NULL and the UI shows no estimate.
--
-- NULL therefore means "we did not witness the departure", and is a normal,
-- expected state — not missing data.

ALTER TABLE public.war_room_state_v2
  ADD COLUMN IF NOT EXISTS travel_departed_at timestamp with time zone;
