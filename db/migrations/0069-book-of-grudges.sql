-- #889: The Book of Grudges — a faction-wide shared target list for chaining.
--
-- Proposed by MonChoon 2026-10-04 for the Halloween chain, but explicitly NOT
-- scoped to it: "It would be nice to have the target list perpetually building
-- up." Nothing here references a war, a chain or an event.
--
-- ⚠️ ONE TARGET, MANY GRUDGES. Two members can independently hold a grudge
-- against the same person, and the list must show that person ONCE with both
-- reasons rather than twice. This is the modelling decision that drives the
-- rest of the schema, and it is why `grudge_entries` exists as a separate
-- table instead of a `reason` column on the target.
--
-- ⚠️ NOTHING IS EVER HARD-DELETED. "I would want to keep a history of edits on
-- that table though to see when targets were added, removed, or changed."
-- Removal sets `removed_at`; `grudge_audit` is append-only. Re-adding a
-- removed target revives the SAME row so its history stays attached to it.

-- ─────────────────────────────────────────────────────────────── targets ──
CREATE TABLE IF NOT EXISTS public.grudge_targets (
  id              bigserial PRIMARY KEY,
  -- The Torn user id is the identity. ⚠️ `target_name` is a CACHE: people
  -- change their name, and a list keyed by name would quietly lose them.
  target_id       text NOT NULL,
  -- ⚠️ NULLABLE, and that is deliberate. Resolving a name needs a Torn call,
  -- and every Torn call in this epic is gated behind the API Key Usage
  -- disclosure update + forced re-accept (slice 0). A target added before that
  -- lands carries its id and nothing else; the UI shows the id until the
  -- enrichment pass fills this in. Storing the id here as a fake name would
  -- make "not looked up yet" indistinguishable from "actually called 2576356".
  target_name     text,
  -- Faction at last lookup, null when unfactioned. Drives both the batched
  -- status refresh (one /faction/{id}/members call covers every target in it)
  -- and the watched-faction approval gate below.
  faction_id      text,
  faction_name    text,
  level           integer,

  -- ⚠️ Three states, not a boolean. A target in a watched faction is ADDED but
  -- withheld from the public list until leadership rules on it: "some pending
  -- state, where if a member adds a target and they are from our faction (or
  -- faction family) it goes into a state where it needs to be approved by
  -- leadership before it is added to the public list."
  state           text NOT NULL DEFAULT 'active'
                  CHECK (state IN ('active', 'pending_approval', 'rejected')),
  state_changed_at timestamptz,
  state_changed_by text,

  -- Battle stats, from whichever provider answered. ⚠️ `stats_source` and
  -- `stats_fetched_at` are NOT optional metadata — a stale or estimated figure
  -- shown as fact is how somebody picks a fight they lose. Mirrors the
  -- spy_source / ts_spy_at convention the war room already uses.
  battle_stats    bigint,
  stats_source    text,
  stats_fetched_at timestamptz,

  -- Last known Torn status. ⚠️ `status_until` is a Torn epoch in SECONDS, not
  -- a timestamptz — it is stored as given so nothing has to guess a timezone.
  status_state    text,
  status_until    bigint,
  status_description text,
  status_fetched_at timestamptz,

  added_by        text NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  removed_by      text
);

-- ⚠️ One row per target, INCLUDING removed ones — a soft-deleted target must
-- still collide so re-adding revives it rather than orphaning its history.
CREATE UNIQUE INDEX IF NOT EXISTS grudge_targets_target_id
  ON public.grudge_targets (target_id);

-- The batched refresh groups by faction; the partial index keeps that cheap
-- without indexing the removed tail.
CREATE INDEX IF NOT EXISTS grudge_targets_faction
  ON public.grudge_targets (faction_id)
  WHERE removed_at IS NULL;

-- ─────────────────────────────────────────────────────────────── grudges ──
CREATE TABLE IF NOT EXISTS public.grudge_entries (
  id          bigserial PRIMARY KEY,
  target_row_id bigint NOT NULL REFERENCES public.grudge_targets(id) ON DELETE CASCADE,
  member_id   text NOT NULL,
  -- ⚠️ NOT NULL and non-empty by constraint. The entire premise is "with the
  -- requirement that they add a description for which grudge the target has
  -- committed to end up on the list" — a blank reason makes the list a plain
  -- target list and the feature pointless.
  reason      text NOT NULL CHECK (btrim(reason) <> ''),
  -- References a faction-configured severity. ⚠️ NOT an enum: severity labels
  -- are a faction setting, because factions will want their own vocabulary and
  -- a hardcoded Low/Medium/High would be both wrong and less fun.
  severity_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  removed_by  text
);

CREATE INDEX IF NOT EXISTS grudge_entries_target
  ON public.grudge_entries (target_row_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS grudge_entries_member
  ON public.grudge_entries (member_id);

-- ───────────────────────────────────────────────────────────────── audit ──
-- ⚠️ APPEND-ONLY. Never updated, never deleted. This table IS the answer to
-- "see when targets were added, removed, or changed", so a row that can be
-- rewritten is worth nothing.
CREATE TABLE IF NOT EXISTS public.grudge_audit (
  id          bigserial PRIMARY KEY,
  target_row_id bigint REFERENCES public.grudge_targets(id) ON DELETE SET NULL,
  -- ⚠️ Kept flat as well as by reference: ON DELETE SET NULL would otherwise
  -- cut the trail loose if a target row ever is hard-deleted by an operator.
  target_id   text NOT NULL,
  entry_id    bigint,
  actor_member_id text NOT NULL,
  action      text NOT NULL
              CHECK (action IN ('added', 'edited', 'removed', 'restored',
                                'approved', 'rejected', 'state_changed')),
  field       text,
  old_value   text,
  new_value   text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grudge_audit_target
  ON public.grudge_audit (target_id, at DESC);
