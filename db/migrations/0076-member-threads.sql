-- #942 — a Discord forum thread per member, and the queue that fills it.
--
-- Two tables, because they answer different questions. The registry is "where
-- does this member's log live"; the outbox is "what have we not said yet".
--
-- ⚠️ **The bot POLLS this; the dashboard never calls the bot.** Chain Watch
-- already works that way across five factions, and the bot is a Discord gateway
-- client with no inbound HTTP server at all. MonChoon: *"basically a mailbox
-- from the dashboard that there are updates waiting to be posted."*
CREATE TABLE IF NOT EXISTS public.member_threads (
  -- ⚠️ `members.member_id` is text, so this is too. A join against a bigint
  -- here silently matches nothing.
  member_id   text PRIMARY KEY,
  -- ⚠️ Discord snowflakes are 64-bit and arrive as strings. Stored as text so
  -- nothing can round-trip one through a float and corrupt the last digits —
  -- which would point a post at a thread that does not exist, or someone
  -- else's.
  thread_id   text NOT NULL,
  channel_id  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_posted_at timestamptz
);

-- What the bot has not posted yet.
--
-- ⚠️ `kind` is free text with no CHECK, like `release_reason` (#530): the
-- vocabulary lives in server/src/memberThreads.ts so a new kind — the war
-- report in #943 — needs no migration.
CREATE TABLE IF NOT EXISTS public.member_thread_outbox (
  id          bigserial PRIMARY KEY,
  member_id   text NOT NULL,
  kind        text NOT NULL,
  -- Everything the bot needs to render, resolved at QUEUE time. ⚠️ Resolved
  -- then rather than at post time because the facts can move: a member who
  -- leaves and rejoins before the bot drains the queue would otherwise have
  -- their join note rendered with their leave state.
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- ⚠️ `claimed_at` rather than a boolean: a crashed drain leaves a row claimed
  -- and never finished, and an age on that claim is what lets a later run tell
  -- "in flight" from "abandoned". A boolean cannot express the difference.
  queued_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at  timestamptz,
  posted_at   timestamptz,
  -- Discord's id for what we posted, recorded the instant it confirms (#946
  -- edits these in place on a re-run).
  message_id  text,
  -- ⚠️ Kept rather than cleared on success, so a row that failed twice and then
  -- worked still says so. A queue that forgets its own failures is one nobody
  -- can diagnose.
  last_error  text,
  attempts    integer NOT NULL DEFAULT 0
);

-- The drain reads "oldest unposted first" on every poll.
CREATE INDEX IF NOT EXISTS member_thread_outbox_pending_idx
  ON public.member_thread_outbox (queued_at)
  WHERE posted_at IS NULL;

-- ⚠️ One outbox row per member per kind per subject. Without this a retried
-- stint sweep queues a second join note and the member's log says they joined
-- twice. `subject` is the war id for a report, and the stint id for a
-- join/leave — see memberThreads.ts.
ALTER TABLE public.member_thread_outbox
  ADD COLUMN IF NOT EXISTS subject text;
CREATE UNIQUE INDEX IF NOT EXISTS member_thread_outbox_once_idx
  ON public.member_thread_outbox (member_id, kind, subject);
