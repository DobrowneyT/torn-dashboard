-- #970 — the live chain report, polled from Torn while a faction event is live.
--
-- ⚠️ The chain report is the SOURCE OF TRUTH for per-member event totals (#967):
-- the numbers members will check us against. It is cumulative, so after an
-- outage the first successful poll is complete again.
--
-- ⚠️ Three tables, because storing every attacker row on every 5-second poll
-- would cost ~3 GB per tenant over an eight-day event:
--   * `event_chain_report_latest`    — the newest full report, one row per event
--                                      (what the live page reads)
--   * `event_chain_report_samples`   — the faction `details` on EVERY change
--                                      (small; the time series)
--   * `event_chain_report_snapshots` — the full report every few minutes, and
--                                      always when the chain changes or ends
--                                      (change over time per member)
CREATE TABLE IF NOT EXISTS public.event_chain_report_latest (
  event_id      bigint PRIMARY KEY REFERENCES public.faction_events(id) ON DELETE CASCADE,
  chain_id      bigint NOT NULL,
  chain_start   timestamptz NOT NULL,
  -- ⚠️ As Torn reports it. A finished chain's `end` is fixed and in the past;
  -- what a RUNNING chain's `end` holds has not been observed yet, so "ended"
  -- is decided by eventChainReport.ts, not by this column being non-null.
  chain_end     timestamptz,
  details       jsonb NOT NULL,
  attackers     jsonb NOT NULL,
  bonuses       jsonb NOT NULL,
  non_attackers jsonb NOT NULL,
  content_hash  text NOT NULL,
  sampled_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_chain_report_samples (
  id          bigserial PRIMARY KEY,
  event_id    bigint NOT NULL REFERENCES public.faction_events(id) ON DELETE CASCADE,
  chain_id    bigint NOT NULL,
  chain_start timestamptz NOT NULL,
  chain_end   timestamptz,
  details     jsonb NOT NULL,
  sampled_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_chain_report_samples_event_time
  ON public.event_chain_report_samples (event_id, sampled_at);

CREATE TABLE IF NOT EXISTS public.event_chain_report_snapshots (
  id            bigserial PRIMARY KEY,
  event_id      bigint NOT NULL REFERENCES public.faction_events(id) ON DELETE CASCADE,
  chain_id      bigint NOT NULL,
  chain_start   timestamptz NOT NULL,
  chain_end     timestamptz,
  details       jsonb NOT NULL,
  attackers     jsonb NOT NULL,
  bonuses       jsonb NOT NULL,
  non_attackers jsonb NOT NULL,
  sampled_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_chain_report_snapshots_event_time
  ON public.event_chain_report_snapshots (event_id, sampled_at);

-- The poller's own health, one row per event: how often it polled, how often
-- the report actually CHANGED (the measurement #970 sets the cadence from),
-- and its failures. ⚠️ An outage must show here as failures, never as quiet
-- successes (#963).
CREATE TABLE IF NOT EXISTS public.event_chain_report_poll_state (
  event_id             bigint PRIMARY KEY REFERENCES public.faction_events(id) ON DELETE CASCADE,
  polls                bigint NOT NULL DEFAULT 0,
  changes              bigint NOT NULL DEFAULT 0,
  failures             bigint NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  skipped              bigint NOT NULL DEFAULT 0,
  last_ok_at           timestamptz,
  last_change_at       timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  last_skip_reason     text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
