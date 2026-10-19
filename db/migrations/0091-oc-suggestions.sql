-- #1020 — the OC action feed. One row per suggestion the dashboard makes.
--
-- Producers (#1021 seat swaps, #1022 joined too low, #1023 not in an OC) report
-- what they see; this table remembers what was posted, what people pressed, and
-- why a suggestion closed. The bot polls it (mailbox pattern, like
-- `member_thread_outbox`) — the dashboard never calls the bot.
CREATE TABLE IF NOT EXISTS public.oc_suggestions (
  id            bigserial PRIMARY KEY,
  -- ⚠️ Stable per situation (kind + crime + members + target), so the same
  -- situation is one row and one message, never a repeat post.
  key           text NOT NULL UNIQUE,
  kind          text NOT NULL,
  crime_id      text,
  member_ids    text[] NOT NULL DEFAULT '{}',
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  -- Numbered moves to make, in order.
  steps         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What following it is worth, e.g. {"success_pp": 6.1, "ev": 38000000}.
  value         jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity      text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'urgent')),
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'snoozed', 'done', 'resolved', 'expired')),
  -- Bumped whenever what the message should show changes; the bot edits until
  -- `rendered_version` catches up.
  version       integer NOT NULL DEFAULT 1,
  rendered_version integer NOT NULL DEFAULT 0,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  snoozed_until timestamptz,
  acted_by      text,
  acted_at      timestamptz,
  closed_at     timestamptz,
  close_reason  text,
  message_id    text,
  channel_id    text,
  posted_at     timestamptz
);

CREATE INDEX IF NOT EXISTS oc_suggestions_attention
  ON public.oc_suggestions (updated_at)
  WHERE rendered_version < version;
