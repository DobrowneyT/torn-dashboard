-- #973 — every event attack's log, archived while it still exists.
--
-- ⚠️ Attack logs EXPIRE (31 days fetch; last Halloween's return error 28). They
-- cannot be backfilled after the event, so this is collected DURING it.
-- ⚠️ `raw` is Torn's response, UNPARSED. The parser will change once a treat
-- has been seen in a log (#975), and the logs will not exist to re-fetch.
-- ⚠️ Identity is `attack_id` from attacks-sync: stealthed attackers appear as
-- "Someone" in the log text.
CREATE TABLE IF NOT EXISTS public.event_attack_logs (
  attack_id       bigint PRIMARY KEY,
  event_id        bigint NOT NULL REFERENCES public.faction_events(id) ON DELETE CASCADE,
  code            text NOT NULL,
  -- archived: stored. gone: Torn says the log does not exist (expired or never
  -- valid) — never retried. failed: will be retried at next_attempt_at.
  status          text NOT NULL CHECK (status IN ('archived', 'gone', 'failed')),
  raw             jsonb,
  lines           integer,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_attack_logs_event_status
  ON public.event_attack_logs (event_id, status);

-- The archiver's health, one row per event. ⚠️ A backlog that grows instead of
-- shrinking must be visible, not silent — logs that wait too long are lost.
CREATE TABLE IF NOT EXISTS public.event_attack_log_state (
  event_id        bigint PRIMARY KEY REFERENCES public.faction_events(id) ON DELETE CASCADE,
  backlog         integer NOT NULL DEFAULT 0,
  growing_since   timestamptz,
  calls           bigint NOT NULL DEFAULT 0,
  keys_available  integer NOT NULL DEFAULT 0,
  last_run_at     timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
