-- Global roster-sync marker, so the #330 travel-departure guard can tell
-- "the board was not watching" from "this member happened not to change".
--
-- The guard exists to refuse a departure we did not witness: stamping now()
-- after a blind spell puts a confidently wrong landing time on the board and a
-- lead waits on it. That intent is right. The implementation asked the wrong
-- question — it compared war_room_state_v2.updated_at against a 120s window,
-- but that row is only written when a member's state actually CHANGES.
--
-- An offline member sitting idle produces an identical payload every tick, so
-- their updated_at stops advancing while the board polls them once a second.
-- Ten minutes later they take off, the guard sees a ten-minute-old row, and
-- discards a departure it watched happen. In production that meant no ETA ever
-- appeared for anyone, because "idle, then travels" is what travelling looks
-- like from the roster's point of view.
--
-- Board liveness is a property of the BOARD, so it is recorded once per sync
-- rather than inferred per member. Surviving a restart is correct behaviour
-- either way: a five-second restart leaves a fresh marker and we really were
-- watching; a ten-minute outage leaves a stale one and we really were not.

ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS last_roster_sync_at timestamp with time zone;
