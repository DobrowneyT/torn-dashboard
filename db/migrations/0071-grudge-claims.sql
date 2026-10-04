-- #892: claiming a target on the Book of Grudges, so a chain does not waste hits.
--
-- ⚠️ **A SEPARATE TABLE from the War Room's dibs, deliberately.** The rules
-- below are lifted from `warRoomDibsExpiry.ts` because each one was learned
-- from a live war and cost real debugging — but the War Room's dibs are
-- war-scoped state with their own expiry job and websocket broadcast, and a
-- grudge claim must not be able to break a war or vice versa. Shared ideas,
-- separate tables.
--
-- ⚠️ **Nothing is hard-deleted**, for the same reason as every other table in
-- this feature: "who had this and when did they let it go" is a question
-- people will ask mid-chain, and a DELETE cannot answer it.
CREATE TABLE IF NOT EXISTS public.grudge_claims (
  id            bigserial PRIMARY KEY,
  target_row_id bigint NOT NULL REFERENCES public.grudge_targets(id) ON DELETE CASCADE,
  member_id     text NOT NULL,

  claimed_at    timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  -- Why it ended: 'manual' | 'spent' | 'window' | 'taken_over'.
  -- ⚠️ Recorded rather than inferred. "The claim went away" is useless at 3am
  -- mid-chain; "it was spent because they went to hospital" is actionable.
  release_reason text,

  -- ⚠️ The #106 countdown. Armed only when a HELD target comes OUT of
  -- hospital: the holder was waiting for exactly that moment, so they get a
  -- short head start before anybody else may take it. NULL means not armed.
  auto_expire_at timestamptz,

  -- ⚠️ The previous status reading, carried on the claim rather than diffed
  -- against the target row. The sweep needs to know what changed SINCE THE
  -- CLAIM last looked, and the target row is overwritten by every refresh —
  -- by the time the sweep runs, the "before" is already gone.
  seen_state    text,
  seen_until    bigint
);

-- ⚠️ One LIVE claim per target. A partial unique index rather than a plain
-- one, because released rows are kept forever and would collide with every
-- future claim on the same target.
CREATE UNIQUE INDEX IF NOT EXISTS grudge_claims_one_live
  ON public.grudge_claims (target_row_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS grudge_claims_member
  ON public.grudge_claims (member_id, claimed_at DESC);
