-- War Room: roll call + war notes + automation ownership.
--
-- Adds the pre-war "roll call" availability survey (native replacement for the
-- Google Form), per-war leadership notes / war-type metadata, and two config
-- columns that let the pg_cron lifecycle automation own a session WITHOUT
-- clobbering manual/testing sessions.
--
-- Conventions mirror the existing v2 War Room tables:
--   * RLS strict_*_faction_select using current_faction_id() = '10739'
--   * touch_updated_at_v2() trigger (defined out-of-band in the live DB)
--   * writes happen via the service-role edge function; no write policies.

-- ── Roll call ─────────────────────────────────────────────────────────────────
-- One row per member per war. Members submit via the edge function (which
-- derives member_id from their key); everyone in-faction can read (the whole
-- point is shared availability). `revised` flags an answer edited after the
-- first submission so leadership can spot changes.

CREATE TABLE IF NOT EXISTS public.war_room_roll_call_v2 (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  war_id             bigint NOT NULL,
  member_id          bigint NOT NULL,
  member_name        text,
  on_at_start        boolean NOT NULL,
  can_self_hospital  boolean,          -- only meaningful when on_at_start = false
  needs_merc         boolean,          -- "No, will need merc hit"
  availability       text,             -- on_time | 1_2h | 3_5h | 6_plus | unavailable
  revised            boolean NOT NULL DEFAULT false,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT war_room_roll_call_v2_uniq UNIQUE (war_id, member_id)
);

CREATE INDEX IF NOT EXISTS war_room_roll_call_v2_war_idx
  ON public.war_room_roll_call_v2 (war_id);

ALTER TABLE public.war_room_roll_call_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "strict_war_room_roll_call_v2_faction_select"
  ON public.war_room_roll_call_v2;
CREATE POLICY "strict_war_room_roll_call_v2_faction_select"
  ON public.war_room_roll_call_v2 FOR SELECT
  TO authenticated
  USING (current_faction_id() = '10739'::text);

GRANT SELECT ON public.war_room_roll_call_v2 TO authenticated;

-- ── War notes / metadata ──────────────────────────────────────────────────────
-- One row per war. War-type + agreed scores + free-text strategy. Editable by
-- War Leaders only (enforced in the edge function); readable in-faction so the
-- war summary card can show it to everyone.

-- Public note + war metadata. `notes_public` and the war type/scores are shown
-- to everyone in the war summary, so this table is faction-readable. Termed wars
-- carry two agreed scores (ours / theirs). `updated_at` is the optimistic-lock
-- token for concurrent War-Leader edits (see save_war_notes_v2).
CREATE TABLE IF NOT EXISTS public.war_room_notes_v2 (
  war_id              bigint PRIMARY KEY,
  opponent_faction_id bigint,
  war_type            text,            -- real | termed | race
  termed_score_us     integer,
  termed_score_them   integer,
  race_target_score   integer,
  notes_public        text,
  updated_by_id       bigint,
  updated_by_name     text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.war_room_notes_v2 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "strict_war_room_notes_v2_faction_select"
  ON public.war_room_notes_v2;
CREATE POLICY "strict_war_room_notes_v2_faction_select"
  ON public.war_room_notes_v2 FOR SELECT
  TO authenticated
  USING (current_faction_id() = '10739'::text);

GRANT SELECT ON public.war_room_notes_v2 TO authenticated;

-- Bump updated_at on save (reuse the shared trigger fn from the v2 base tables).
DROP TRIGGER IF EXISTS touch_updated_at_notes_v2 ON public.war_room_notes_v2;
CREATE TRIGGER touch_updated_at_notes_v2
  BEFORE INSERT OR UPDATE ON public.war_room_notes_v2
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_v2();

-- Private (War-Leader-only) notes — e.g. negotiation details members must NOT
-- see. RLS can't hide a single column, so private notes live in their own
-- service-role-only table: RLS on, NO select policy, REVOKE from client roles
-- (same lock-down as member_secrets). War Leaders read it via the edge function
-- (get_war_notes_private_v2); never directly from the client.
CREATE TABLE IF NOT EXISTS public.war_room_notes_private_v2 (
  war_id          bigint PRIMARY KEY,
  notes           text,
  updated_by_id   bigint,
  updated_by_name text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.war_room_notes_private_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.war_room_notes_private_v2 FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS touch_updated_at_notes_private_v2 ON public.war_room_notes_private_v2;
CREATE TRIGGER touch_updated_at_notes_private_v2
  BEFORE INSERT OR UPDATE ON public.war_room_notes_private_v2
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_v2();

-- ── Config: automation ownership ──────────────────────────────────────────────
-- auto_managed = the lifecycle automation set up & owns the current session.
-- managed_war_id = the ranked_wars.id it owns. Auto-enable/auto-disable only act
-- when auto_managed is true, so manual/testing sessions are never auto-touched.
ALTER TABLE public.war_room_config_v2
  ADD COLUMN IF NOT EXISTS auto_managed   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS managed_war_id bigint;

-- ── Lifecycle cron (APPLY MANUALLY — mirrors the out-of-band war-room cron) ───
-- The existing 1-second `cron_poll_war_room` job is defined directly in the live
-- DB (not in repo), using pg_cron + pg_net + a Vault-stored secret. Add a second,
-- low-frequency job that POSTs the new `cron_war_lifecycle` action. Copy the
-- net.http_post body from the existing job and change only the action + schedule:
--
--   select cron.schedule(
--     'war_room_lifecycle',
--     '*/3 * * * *',
--     $$
--       select net.http_post(
--         url     := '<SUPABASE_URL>/functions/v1/war-room-fetch',
--         headers := jsonb_build_object(
--           'Content-Type',  'application/json',
--           'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
--                              where name = 'war_room_cron_secret')
--         ),
--         body    := jsonb_build_object('action', 'cron_war_lifecycle')
--       );
--     $$
--   );
--
-- (Left as a comment so applying this migration never fails on a missing
-- pg_net/vault setup; wire it once, the same way the existing job was.)
