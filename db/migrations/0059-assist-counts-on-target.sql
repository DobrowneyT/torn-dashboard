-- #617: assist requests belong to the TARGET, not to whoever typed them.
--
-- #523 built assists around one live request per requester, enforced by a
-- partial unique index on requester_id. Two rules followed from that, and both
-- are wrong:
--
--   * a second person raising a hand on a target REPLACED the first request;
--   * a different kind from the same person replaced their previous one.
--
-- The reinforcement case makes it plainest: whoever joined a fight is now IN it
-- and is the best-placed person to say more help is needed — and under the old
-- rule their request cancelled the one that brought them.
--
-- Counts now live on the target, per kind, and coexist: a target can need a
-- smoke AND a tear AND a body.

-- ⚠️ Rebuilt rather than altered. The old table is a row per REQUEST and the
-- new one is a row per TARGET; there is no column-by-column path between them,
-- and pretending otherwise would leave the partial unique index on requester_id
-- silently enforcing the rule this migration exists to remove.
CREATE TABLE IF NOT EXISTS war_room_assist_counts_v2 (
  target_id      bigint PRIMARY KEY,
  war_id         bigint,

  -- ⚠️ One column per kind, per the request. Kinds never cancel each other.
  -- Adding a fourth needs a migration — which was already true, since the old
  -- `kind` column carried CHECK (kind IN ('smoke','tear','help')).
  help_wanted    integer NOT NULL DEFAULT 0 CHECK (help_wanted  >= 0),
  smoke_wanted   integer NOT NULL DEFAULT 0 CHECK (smoke_wanted >= 0),
  tear_wanted    integer NOT NULL DEFAULT 0 CHECK (tear_wanted  >= 0),

  -- ⚠️ Expiry is per KIND, not per row. A smoke asked for four minutes ago and
  -- a tear asked for just now must not age out together — and when a kind does
  -- age out the whole kind clears, rather than decaying a unit at a time on a
  -- clock that matches neither raise.
  help_raised_at  timestamp with time zone,
  smoke_raised_at timestamp with time zone,
  tear_raised_at  timestamp with time zone,

  -- ⚠️ Kept for ONE purpose and never displayed: the #591 rule that a person
  -- asking for help cannot answer it themselves by turning up. Their own join
  -- would otherwise cancel the request the moment they made it. With counts
  -- shared there is no `requester_id` to check, so the contributors are stored.
  --
  -- Only `help` needs this. A smoke you throw yourself after asking for three
  -- is genuinely one of the three, which is why grenades were never excluded.
  help_raised_by  bigint[] NOT NULL DEFAULT '{}',

  updated_at     timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS war_room_assist_counts_v2_updated_at_idx
  ON war_room_assist_counts_v2 (updated_at);

-- ⚠️ Backfill by SUMMING per target and kind, not by taking one row. Two people
-- asking for a smoke on the same target is exactly the case this migration
-- exists to represent, and picking one would silently discard the other on the
-- way in.
INSERT INTO war_room_assist_counts_v2
  (target_id, war_id, help_wanted, smoke_wanted, tear_wanted,
   help_raised_at, smoke_raised_at, tear_raised_at, help_raised_by, updated_at)
SELECT
  target_id,
  max(war_id),
  COALESCE(sum(wanted) FILTER (WHERE kind = 'help'),  0)::int,
  COALESCE(sum(wanted) FILTER (WHERE kind = 'smoke'), 0)::int,
  COALESCE(sum(wanted) FILTER (WHERE kind = 'tear'),  0)::int,
  max(created_at) FILTER (WHERE kind = 'help'),
  max(created_at) FILTER (WHERE kind = 'smoke'),
  max(created_at) FILTER (WHERE kind = 'tear'),
  COALESCE(array_agg(DISTINCT requester_id) FILTER (WHERE kind = 'help'), '{}'),
  now()
FROM war_room_assists_v2
WHERE deleted_at IS NULL AND wanted > 0
GROUP BY target_id
ON CONFLICT (target_id) DO NOTHING;

-- ⚠️ The old table is KEPT, not dropped, and the code stops reading it. A live
-- war may be in flight while this deploys, and the rows are the only record of
-- what people had asked for. Dropping it is a separate, later migration once
-- the new shape has run through a war — the same discipline as #606's mirror
-- tables. Its partial unique index on requester_id is dropped, though, because
-- leaving it would keep enforcing the very rule being removed if anything ever
-- wrote there again.
DROP INDEX IF EXISTS war_room_assists_v2_active_requester_idx;
